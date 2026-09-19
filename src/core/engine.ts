import { Scheduler } from './scheduler';
import { OrderbookStream } from '../data/orderbook_stream';
import { WalletManager } from '../wallets/wallet_manager';
import { OrderRouter } from '../execution/order_router';
import { StrategyInterface } from '../strategies/strategy_interface';
import { STRATEGY_REGISTRY } from '../strategies/registry';
import { AppConfig, MarketData } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

interface StrategyRunner {
  strategy: StrategyInterface;
  walletId: string;
  config: Record<string, unknown>;
}

export class Engine {
  private readonly scheduler = new Scheduler();
  private readonly stream: OrderbookStream;
  private readonly runners: StrategyRunner[] = [];
  private readonly pausedWallets = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly walletManager: WalletManager,
    private readonly orderRouter: OrderRouter,
    /**
     * Injected for replay: a ReplayStream driven by a recorded tape exposes
     * the same events and accessors, so the strategies under test are the
     * real ones rather than a parallel simulation of them.
     */
    stream?: OrderbookStream,
  ) {
    this.stream = stream ?? new OrderbookStream(config.polymarket.gammaApi);
  }

  async initialize(): Promise<void> {
    for (const wallet of this.config.wallets) {
      const StrategyCtor = STRATEGY_REGISTRY[wallet.strategy];
      if (!StrategyCtor) {
        logger.warn({ strategy: wallet.strategy }, 'Unknown strategy; skipping');
        consoleLog.warn(
          'ENGINE',
          `Unknown strategy "${wallet.strategy}" — skipping wallet ${wallet.id}`,
        );
        continue;
      }
      const walletState = this.walletManager.getWallet(wallet.id)?.getState();
      if (!walletState) {
        logger.warn({ walletId: wallet.id }, 'Wallet not registered in WalletManager; skipping');
        consoleLog.warn(
          'ENGINE',
          `Wallet "${wallet.id}" not found — skipping. Check ENABLE_LIVE_TRADING setting.`,
        );
        continue;
      }
      const strategy = new StrategyCtor();
      strategy.initialize({
        wallet: walletState,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      this.runners.push({
        strategy,
        walletId: wallet.id,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      consoleLog.info('STRATEGY', `Initialized "${wallet.strategy}" for wallet ${wallet.id}`, {
        walletId: wallet.id,
        strategy: wallet.strategy,
        capital: walletState.capitalAllocated,
        mode: walletState.mode,
      });
    }

    // A new poll cycle: clear each strategy's stale market map before the
    // fresh per-market updates repopulate it with only active markets.
    this.stream.on('snapshotBegin', () => {
      for (const runner of this.runners) {
        runner.strategy.onSnapshotBegin();
      }
    });
    this.stream.on('update', (data) => this.handleMarketUpdate(data));
  }

  /** One tick, for replay — the scheduler is not running in that mode. */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  start(): void {
    this.stream.start();
    this.scheduler.start(() => this.tick());
    logger.info({ wallets: this.runners.length }, 'Engine started with LIVE Polymarket data');
    consoleLog.success(
      'ENGINE',
      `Engine started — ${this.runners.length} strategy runners active`,
      {
        runners: this.runners.length,
        strategies: [...new Set(this.runners.map((r) => r.strategy.name))],
      },
    );
  }

  stop(): void {
    this.scheduler.stop();
    this.stream.stop();
    logger.info('Engine stopped');
    consoleLog.warn('ENGINE', 'Engine stopped');
  }

  /** Expose the stream so the dashboard can query live market data */
  getStream(): OrderbookStream {
    return this.stream;
  }

  /* ━━━━━━━━━━━━━━ Runtime runner management ━━━━━━━━━━━━━━ */

  /**
   * Add a strategy runner for a wallet that was created at runtime
   * (e.g. via the dashboard).  The runner immediately receives all
   * cached market data so the strategy has context for its first tick.
   */
  addRunner(walletId: string, strategyKey: string): boolean {
    // Prevent duplicate runners for the same wallet
    if (this.runners.some((r) => r.walletId === walletId)) {
      logger.warn({ walletId }, 'Runner already exists for wallet');
      return false;
    }

    const StrategyCtor = STRATEGY_REGISTRY[strategyKey];
    if (!StrategyCtor) {
      logger.warn({ walletId, strategy: strategyKey }, 'Unknown strategy; cannot add runner');
      return false;
    }

    const walletState = this.walletManager.getWallet(walletId)?.getState();
    if (!walletState) {
      logger.warn({ walletId }, 'Wallet not found in WalletManager');
      return false;
    }

    const strategy = new StrategyCtor();
    const cfg = this.config.strategyConfig[strategyKey] ?? {};
    strategy.initialize({ wallet: walletState, config: cfg });

    this.runners.push({ strategy, walletId, config: cfg });

    // Back-fill cached market data so the strategy can evaluate immediately
    for (const market of this.stream.getAllMarkets()) {
      strategy.onMarketUpdate(market);
    }

    logger.info(
      { walletId, strategy: strategyKey, cachedMarkets: this.stream.getAllMarkets().length },
      `Runtime runner added for wallet ${walletId} (${strategyKey})`,
    );
    consoleLog.success('WALLET', `Runtime runner added: ${walletId} → ${strategyKey}`, {
      walletId,
      strategy: strategyKey,
      cachedMarkets: this.stream.getAllMarkets().length,
    });
    return true;
  }

  /**
   * Remove the strategy runner for a wallet (e.g. on wallet deletion).
   */
  removeRunner(walletId: string): boolean {
    const idx = this.runners.findIndex((r) => r.walletId === walletId);
    if (idx === -1) return false;

    const runner = this.runners[idx];
    runner.strategy.shutdown();
    this.runners.splice(idx, 1);
    logger.info({ walletId }, `Runtime runner removed for wallet ${walletId}`);
    consoleLog.warn('WALLET', `Runner removed: ${walletId} (${runner.strategy.name})`, {
      walletId,
      strategy: runner.strategy.name,
      remainingRunners: this.runners.length,
    });
    return true;
  }

  /** Number of active strategy runners (for dashboard display). */
  getRunnerCount(): number {
    return this.runners.length;
  }

  /** Get all strategy instances that match a given strategy name (for runtime config). */
  getStrategiesByName(strategyName: string): StrategyInterface[] {
    return this.runners
      .filter(
        (r) =>
          r.config === this.config.strategyConfig[strategyName] || r.strategy.name === strategyName,
      )
      .map((r) => r.strategy);
  }

  /* ━━━━━━━━━━━━━━ Pause / Resume ━━━━━━━━━━━━━━ */

  /**
   * Pause a wallet's strategy runner.  The runner stays in the list
   * (and still receives market updates to stay in-sync) but will not
   * generate signals, size positions, or place orders.
   */
  pauseRunner(walletId: string): boolean {
    if (!this.runners.some((r) => r.walletId === walletId)) return false;
    this.pausedWallets.add(walletId);
    consoleLog.warn('ENGINE', `Runner paused: ${walletId}`, { walletId });
    return true;
  }

  /**
   * Resume a previously paused wallet runner.
   */
  resumeRunner(walletId: string): boolean {
    if (!this.pausedWallets.has(walletId)) return false;
    this.pausedWallets.delete(walletId);
    consoleLog.success('ENGINE', `Runner resumed: ${walletId}`, { walletId });
    return true;
  }

  /** Check whether a specific wallet runner is paused. */
  isRunnerPaused(walletId: string): boolean {
    return this.pausedWallets.has(walletId);
  }

  /** Return the set of all currently paused wallet IDs. */
  getPausedWallets(): Set<string> {
    return new Set(this.pausedWallets);
  }

  /** Reconcile runs inside the tick, never beside it — see setReconciler(). */
  private reconciler?: () => Promise<void>;
  private reconcileIntervalMs = 30_000;
  private lastReconcileAt = 0;

  /**
   * Run reconciliation as the first step of a tick rather than on its own
   * timer.  On a separate timer it can overwrite balances and positions
   * while a tick sits between its risk check and its order post, and the
   * order commits against a balance that no longer exists.  Inside the tick,
   * and with the scheduler's overlap guard, that interleaving cannot happen.
   */
  setReconciler(reconciler: () => Promise<void>, intervalMs: number): void {
    this.reconciler = reconciler;
    this.reconcileIntervalMs = intervalMs;
  }

  private tickCount = 0;
  private marketUpdateCount = 0;
  private lastScanLog = 0;

  private async tick(): Promise<void> {
    this.tickCount++;

    if (this.reconciler && Date.now() - this.lastReconcileAt >= this.reconcileIntervalMs) {
      this.lastReconcileAt = Date.now();
      await this.reconciler();
    }

    // Log a periodic scan summary every 12 ticks (~60 s at 5 s interval)
    if (this.tickCount % 12 === 0) {
      consoleLog.debug(
        'ENGINE',
        `Tick #${this.tickCount} — ${this.runners.length} runners, ${this.stream.getAllMarkets().length} cached markets, ${this.marketUpdateCount} updates since last summary`,
      );
      this.marketUpdateCount = 0;
    }

    for (const runner of this.runners) {
      if (this.pausedWallets.has(runner.walletId)) continue; // skip paused
      runner.strategy.onTimer();
      await this.processSignals(runner);
    }
  }

  private handleMarketUpdate(data: MarketData): void {
    this.marketUpdateCount++;

    // Throttle per-market update logs to at most once every 30 s
    const now = Date.now();
    if (now - this.lastScanLog > 30_000) {
      consoleLog.debug(
        'SCAN',
        `Market update: ${data.marketId?.slice(0, 12)}… — ${data.outcomes?.length ?? 0} outcomes`,
        {
          marketId: data.marketId,
          question: data.question?.slice(0, 80),
        },
      );
      this.lastScanLog = now;
    }

    for (const runner of this.runners) {
      runner.strategy.onMarketUpdate(data);
    }
  }

  private async processSignals(runner: StrategyRunner): Promise<void> {
    const signals = await runner.strategy.generateSignals();

    // Log signal count every tick for visibility (debug level when 0, info when > 0)
    if (signals.length > 0) {
      consoleLog.info(
        'SIGNAL',
        `[${runner.strategy.name}] Generated ${signals.length} signal(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategy: runner.strategy.name,
          signals: signals.map((s) => ({
            market: s.marketId.slice(0, 12) + '…',
            outcome: s.outcome,
            side: s.side,
            confidence: Number((s.confidence ?? 0).toFixed(3)),
            edge: Number((s.edge ?? 0).toFixed(4)),
          })),
        },
      );
    } else if (this.tickCount % 12 === 0) {
      // Every ~60s, log market count per strategy so we know they're scanning
      const marketCount =
        (runner.strategy as unknown as { markets?: Map<string, unknown> }).markets?.size ?? 0;
      logger.info(
        { strategy: runner.strategy.name, walletId: runner.walletId, marketCount, signals: 0 },
        `[${runner.strategy.name}] 0 signals from ${marketCount} markets (wallet ${runner.walletId})`,
      );
    }

    const orders = await runner.strategy.sizePositions(signals);
    if (orders.length > 0) {
      consoleLog.info(
        'ORDER',
        `[${runner.strategy.name}] Sized ${orders.length} order(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategy: runner.strategy.name,
          orders: orders.map((o) => ({
            market: o.marketId.slice(0, 12) + '…',
            outcome: o.outcome,
            side: o.side,
            price: o.price,
            size: o.size,
          })),
        },
      );
    }

    /* ── Cancel-replace ──
       A quoting strategy is about to post fresh quotes in these markets, so
       pull the previous ones first. A resting quote you never cancel is a
       free option written to the market — it gets picked off on every
       adverse move. */
    if (runner.strategy.replacesQuotes && orders.length > 0) {
      const wallet = this.walletManager.getWallet(runner.walletId);
      if (wallet?.cancelOrdersForMarket) {
        for (const marketId of new Set(orders.map((o) => o.marketId))) {
          try {
            const n = await wallet.cancelOrdersForMarket(marketId);
            if (n > 0) {
              consoleLog.debug(
                'ORDER',
                `[${runner.strategy.name}] Cancelled ${n} stale quote(s) in ${marketId.slice(0, 12)}… before re-quoting`,
                { walletId: runner.walletId, marketId, cancelled: n },
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            consoleLog.error(
              'ORDER',
              `[${runner.strategy.name}] Cancel-replace FAILED for ${marketId} — not posting a new quote on top of the old one: ${msg}`,
              { walletId: runner.walletId, marketId, error: msg },
            );
            return; // better to skip a cycle than to stack duplicate quotes
          }
        }
      }
    }

    for (const order of orders) {
      try {
        const result = await this.orderRouter.route(order);
        if (!result) continue; // rejected by risk, or no such wallet

        // Accepted is not filled: a resting GTC order has filled nothing yet.
        // Telling the strategy otherwise is how its inventory goes fictional.
        if (result.filledSize > 0) {
          runner.strategy.notifyFill({ ...order, size: result.filledSize });
          consoleLog.success(
            'FILL',
            `[${runner.strategy.name}] Filled ${order.side} ${order.outcome} ×${result.filledSize} @ $${order.price.toFixed(4)}`,
            {
              walletId: order.walletId,
              strategy: order.strategy,
              marketId: order.marketId,
              outcome: order.outcome,
              side: order.side,
              price: order.price,
              size: result.filledSize,
              restingSize: result.restingSize,
              cost: Number((order.price * result.filledSize).toFixed(4)),
            },
          );
        } else {
          // Accepted but unfilled — still a working order, so arm the cooldown
          // or we re-quote this market on the very next tick.
          runner.strategy.notifyResting(order);
          consoleLog.debug(
            'ORDER',
            `[${runner.strategy.name}] Resting ${order.side} ${order.outcome} ×${result.restingSize} @ $${order.price.toFixed(4)} — no fill yet`,
            {
              walletId: order.walletId,
              marketId: order.marketId,
              orderId: result.orderId,
              restingSize: result.restingSize,
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Order failed: ${msg}`, {
          walletId: order.walletId,
          marketId: order.marketId,
          error: msg,
        });
      }
    }

    await runner.strategy.managePositions();

    /* ── Route exit orders produced by managePositions() ── */
    const exitOrders = runner.strategy.drainExitOrders();
    if (exitOrders.length > 0) {
      consoleLog.info(
        'ORDER',
        `[${runner.strategy.name}] ${exitOrders.length} exit order(s) for wallet ${runner.walletId}`,
        {
          walletId: runner.walletId,
          strategy: runner.strategy.name,
          exits: exitOrders.map((o) => ({
            market: o.marketId.slice(0, 12) + '…',
            outcome: o.outcome,
            side: o.side,
            price: o.price,
            size: o.size,
          })),
        },
      );
    }

    for (const exitOrder of exitOrders) {
      try {
        const result = await this.orderRouter.route(exitOrder);

        // Strategies release positions via queueExit()'s callback, which runs
        // on fill only — so an unfilled exit correctly leaves the position
        // open, and the strategy retries it after exitRetryMs.
        if (result && result.filledSize === 0) {
          runner.strategy.notifyResting(exitOrder);
          consoleLog.debug(
            'ORDER',
            `[${runner.strategy.name}] Exit resting ×${result.restingSize} @ $${exitOrder.price.toFixed(4)} — position stays open until it fills`,
            {
              walletId: exitOrder.walletId,
              marketId: exitOrder.marketId,
              orderId: result.orderId,
              restingSize: result.restingSize,
            },
          );
        }

        if (result && result.filledSize > 0) {
          // Settles the working exit, which is what releases the position.
          runner.strategy.notifyFill({ ...exitOrder, size: result.filledSize });
          consoleLog.success(
            'FILL',
            `[${runner.strategy.name}] Exited ${exitOrder.outcome} ×${result.filledSize} @ $${exitOrder.price.toFixed(4)}`,
            {
              walletId: exitOrder.walletId,
              strategy: exitOrder.strategy,
              marketId: exitOrder.marketId,
              outcome: exitOrder.outcome,
              side: exitOrder.side,
              price: exitOrder.price,
              size: exitOrder.size,
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Exit order failed: ${msg}`, {
          walletId: exitOrder.walletId,
          marketId: exitOrder.marketId,
          error: msg,
        });
      }
    }
  }
}