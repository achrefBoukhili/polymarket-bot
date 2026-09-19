import { MarketData, OrderRequest, Signal, WalletState } from '../types';

export interface StrategyContext {
  wallet: WalletState;
  config: Record<string, unknown>;
}

export interface StrategyInterface {
  readonly name: string;
  initialize(context: StrategyContext): Promise<void> | void;
  /** Called once per poll snapshot, before that cycle's onMarketUpdate calls. */
  onSnapshotBegin(): void;
  /**
   * True for strategies that re-quote the same markets every cycle. The
   * engine pulls their previous resting orders before posting new ones;
   * without that, stale quotes stack up as free options.
   */
  readonly replacesQuotes?: boolean;
  onMarketUpdate(data: MarketData): Promise<void> | void;
  onTimer(): Promise<void> | void;
  generateSignals(): Promise<Signal[]> | Signal[];
  sizePositions(signals: Signal[]): Promise<OrderRequest[]> | OrderRequest[];
  submitOrders(orders: OrderRequest[]): Promise<void> | void;
  notifyFill(order: OrderRequest): void;
  notifyResting(order: OrderRequest): void;
  managePositions(): Promise<void> | void;
  drainExitOrders(): OrderRequest[];
  shutdown(): Promise<void> | void;
}

export abstract class BaseStrategy implements StrategyInterface {
  abstract readonly name: string;
  protected context?: StrategyContext;

  /** Live market cache populated by onMarketUpdate() */
  protected markets = new Map<string, MarketData>();

  /**
   * Exit orders queued by managePositions() — the engine drains and
   * routes these through the wallet after each tick.
   */
  protected pendingExits: OrderRequest[] = [];

  /**
   * Per-market cooldown: prevents trading the same market more than once
   * within a cooldown window (default 60 seconds).
   */
  private tradeCooldowns = new Map<string, number>();
  protected cooldownMs = 60_000;

  initialize(context: StrategyContext): void {
    this.context = context;
  }

  /**
   * Called once at the start of every new poll snapshot, before any
   * onMarketUpdate() calls arrive for that cycle.
   *
   * Clears the strategy's market map so that only markets present in the
   * current API response survive — closed or inactive markets are dropped
   * automatically without any cap, TTL, or eviction heuristic.
   */
  onSnapshotBegin(): void {
    this.markets.clear();
  }

  onMarketUpdate(data: MarketData): void {
    this.markets.set(data.marketId, data);
  }

  onTimer(): void {
    return;
  }

  abstract generateSignals(): Signal[];

  /** Filter signals through cooldown, then size them */
  sizePositions(signals: Signal[]): OrderRequest[] {
    const now = Date.now();
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Prune expired cooldowns from memory
    for (const [key, lastTrade] of this.tradeCooldowns) {
      if (now - lastTrade > this.cooldownMs) {
        this.tradeCooldowns.delete(key);
      }
    }

    // Filter out signals for markets still in cooldown
    const filtered = signals.filter((s) => {
      const key = `${s.marketId}:${s.outcome}:${s.side}`;
      const lastTrade = this.tradeCooldowns.get(key) ?? 0;
      return now - lastTrade > this.cooldownMs;
    });

    return filtered.map((signal) => {
      const key = `${signal.marketId}:${signal.outcome}:${signal.side}`;

      // Use actual market price when available, fall back to 0.5 + edge
      const market = this.markets.get(signal.marketId);
      let price: number;
      if (market) {
        price =
          signal.outcome === 'YES'
            ? market.outcomePrices[0]
            : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
      } else {
        price = Number((0.5 + signal.edge).toFixed(4));
      }

      // Resolve CLOB token ID for the outcome (index 0 = YES, index 1 = NO)
      const tokenId = market ? market.clobTokenIds[signal.outcome === 'YES' ? 0 : 1] : undefined;

      return {
        walletId,
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        price: Number(Math.max(0.01, Math.min(0.99, price)).toFixed(4)),
        size: Math.max(1, Math.floor(10 * signal.confidence)),
        strategy: this.name,
        tokenId,
      };
    });
  }

  submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /**
   * Called by the engine after a successful fill.
   * Override in subclasses to track positions.
   */
  notifyFill(order: OrderRequest): void {
    // Record cooldown only after a successful fill, not at sizing time
    this.armCooldown(order);
    // Release any position this fill was exiting.
    this.settleExit(order);
  }

  /**
   * Called by the engine when an order was accepted but is resting unfilled.
   *
   * The cooldown has to arm here too.  A working order is a reason not to
   * quote the same market again — without this the engine re-quotes every
   * tick while the first order sits on the book, stacking duplicates.
   */
  notifyResting(order: OrderRequest): void {
    this.armCooldown(order);
  }

  private armCooldown(order: OrderRequest): void {
    this.tradeCooldowns.set(this.orderKey(order), Date.now());
  }

  private orderKey(order: { marketId: string; outcome: string; side: string }): string {
    return `${order.marketId}:${order.outcome}:${order.side}`;
  }

  /* ━━━━━━━━━━━━━━ Exit lifecycle ━━━━━━━━━━━━━━

     An exit order is a request, not an outcome.  Releasing the position at
     queue time — which every strategy used to do — means an exit that rests
     unfilled leaves the strategy believing it is flat while the position is
     still open.  Positions are released here, on fill, and only for the
     quantity that actually filled.                                        */

  /** Exits handed to the engine and not yet fully filled. */
  private pendingExitState = new Map<
    string,
    { remaining: number; queuedAt: number; onFilled: (filledSize: number) => void }
  >();

  /** How long to wait before re-queueing an exit that never filled. */
  protected exitRetryMs = 60_000;

  /**
   * Queue an exit and say what to do when (and only when) it fills.
   *
   * Returns false if an exit for this market/outcome/side is already working,
   * which is what stops managePositions() from re-queueing the same exit on
   * every tick now that the position survives until the fill lands.
   */
  protected queueExit(order: OrderRequest, onFilled: (filledSize: number) => void): boolean {
    const key = this.orderKey(order);
    const existing = this.pendingExitState.get(key);

    if (existing) {
      if (Date.now() - existing.queuedAt < this.exitRetryMs) return false;
      // Stale: it never filled, so its callback never ran and the position
      // was never released. Drop it and let this fresh attempt through.
      this.pendingExitState.delete(key);
    }

    this.pendingExits.push(order);
    this.pendingExitState.set(key, { remaining: order.size, queuedAt: Date.now(), onFilled });
    return true;
  }

  /** Apply a fill against a working exit, if this fill is one. */
  private settleExit(order: OrderRequest): void {
    const key = this.orderKey(order);
    const pending = this.pendingExitState.get(key);
    if (!pending) return;

    const filled = Math.min(order.size, pending.remaining);
    if (filled <= 0) return;

    pending.remaining -= filled;
    if (pending.remaining <= 0) this.pendingExitState.delete(key);

    pending.onFilled(filled);
  }

  /** Exits currently working, for diagnostics. */
  protected hasWorkingExit(order: { marketId: string; outcome: string; side: string }): boolean {
    return this.pendingExitState.has(this.orderKey(order));
  }

  managePositions(): void {
    return;
  }

  /** Return and clear any exit orders queued during managePositions() */
  drainExitOrders(): OrderRequest[] {
    const exits = this.pendingExits;
    this.pendingExits = [];
    return exits;
  }

  shutdown(): void {
    return;
  }
}
