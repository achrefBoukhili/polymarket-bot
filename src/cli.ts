import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { loadConfig } from './core/config_loader';
import { WalletManager } from './wallets/wallet_manager';
import { KillSwitch } from './risk/kill_switch';
import { RiskEngine } from './risk/risk_engine';
import { TradeExecutor } from './execution/trade_executor';
import { OrderRouter } from './execution/order_router';
import { Engine } from './core/engine';
import { Database } from './storage/database';

import { findSettlements } from './execution/settlement';
import { BookFeed, bestBid, bestAsk } from './data/book_feed';
import { BookSocket } from './data/book_socket';
import { TapeRecorder, ReplayStream, readTape } from './data/tape';
import { describeAttribution } from './reporting/attribution';
import { alert } from './reporting/alerts';
import { gracefulShutdown } from './core/shutdown';
import { listStrategies } from './strategies/registry';
import { computeAllPerformance } from './reporting/performance';
import { drawdown } from './reporting/statistics';
import { logger } from './reporting/logs';
import { DashboardServer } from './reporting/dashboard_server';
import { WhaleService } from './whales/whale_service';
import { WhaleAPI } from './whales/whale_api';
import {
  DEFAULT_WHALE_CONFIG,
  DEFAULT_SCANNER_CONFIG,
  DEFAULT_API_POOL_CONFIG,
  DEFAULT_FAST_SCAN_CONFIG,
  DEFAULT_EXCHANGE_SOURCES,
} from './whales/whale_types';
import type { WhaleTrackingConfig, ScannerConfig } from './whales/whale_types';

const program = new Command();
const statePath = path.resolve('.runtime/state.json');

/* ── Config normalization helpers ── */

/** Convert a snake_case string to camelCase */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Recursively convert all snake_case keys in a plain object to camelCase */
function deepSnakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSnakeToCamel);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[snakeToCamel(k)] = deepSnakeToCamel(v);
    }
    return out;
  }
  return obj;
}

/**
 * YAML scanner config uses human-friendly key names that differ from the
 * TypeScript ScannerConfig property names.  This explicit mapping handles
 * both the legacy snake_case YAML keys and any naming divergences.
 */
const SCANNER_KEY_MAP: Record<string, keyof ScannerConfig> = {
  // Direct camelCase matches (new YAML format)
  enabled: 'enabled',
  scanIntervalMs: 'scanIntervalMs',
  marketsPerScan: 'marketsPerScan',
  minMarketLiquidityUsd: 'minMarketLiquidityUsd',
  minMarketVolume24hUsd: 'minMarketVolume24hUsd',
  tradesPerMarket: 'tradesPerMarket',
  tradePageDepth: 'tradePageDepth',
  minAddressVolumeUsd: 'minAddressVolumeUsd',
  minAddressTrades: 'minAddressTrades',
  minWinRate: 'minWinRate',
  minRoi: 'minRoi',
  autoPromoteMinScore: 'autoPromoteMinScore',
  autoPromoteEnabled: 'autoPromoteEnabled',
  autoPromoteMaxPerScan: 'autoPromoteMaxPerScan',
  bigTradeMinUsd: 'bigTradeMinUsd',
  crossRefEnabled: 'crossRefEnabled',
  crossRefMaxPerBatch: 'crossRefMaxPerBatch',
  clusterDetectionEnabled: 'clusterDetectionEnabled',
  clusterMinWhales: 'clusterMinWhales',
  clusterWindowHours: 'clusterWindowHours',
  parallelFetchBatch: 'parallelFetchBatch',
  // Legacy snake_case → camelCase aliases (backward compat)
  scanIntervalMs_: 'scanIntervalMs', // auto-converted snake hits this
  topMarketsCount: 'marketsPerScan',
  minMarketVolumeUsd: 'minMarketVolume24hUsd',
  tradesPerMarketLimit: 'tradesPerMarket',
  minWhaleTrades: 'minAddressTrades',
  minWhaleVolumeUsd: 'minAddressVolumeUsd',
  minWhaleWinRate: 'minWinRate',
  minWhaleRoi: 'minRoi',
  autoTrackEnabled: 'autoPromoteEnabled',
  autoTrackMinScore: 'autoPromoteMinScore',
  autoTrackMaxPerScan: 'autoPromoteMaxPerScan',
};

/** Normalise a raw YAML scanner object into a proper ScannerConfig */
function normaliseScannerConfig(raw: Record<string, unknown>): ScannerConfig {
  // First convert any remaining snake_case keys to camelCase
  const camelRaw = deepSnakeToCamel(raw) as Record<string, unknown>;

  const out: Record<string, unknown> = { ...DEFAULT_SCANNER_CONFIG };
  for (const [key, value] of Object.entries(camelRaw)) {
    const mapped = SCANNER_KEY_MAP[key];
    if (mapped) {
      out[mapped] = value;
    }
  }

  /* ── Deep-merge nested config objects ── */

  // apiPool
  const apiPoolRaw = (camelRaw.apiPool ?? {}) as Record<string, unknown>;
  out.apiPool = {
    ...DEFAULT_API_POOL_CONFIG,
    ...apiPoolRaw,
    endpoints: Array.isArray(apiPoolRaw.endpoints)
      ? apiPoolRaw.endpoints
      : DEFAULT_API_POOL_CONFIG.endpoints,
  };

  // fastScan
  const fastScanRaw = (camelRaw.fastScan ?? {}) as Record<string, unknown>;
  out.fastScan = { ...DEFAULT_FAST_SCAN_CONFIG, ...fastScanRaw };

  // exchangeSources
  if (Array.isArray(camelRaw.exchangeSources)) {
    out.exchangeSources = camelRaw.exchangeSources;
  } else {
    out.exchangeSources = [...DEFAULT_EXCHANGE_SOURCES];
  }

  // Simple scalar fields that pass through unchanged
  if (camelRaw.backfillDays !== undefined) out.backfillDays = camelRaw.backfillDays;
  if (camelRaw.polygonRpcUrl !== undefined) out.polygonRpcUrl = camelRaw.polygonRpcUrl;
  if (camelRaw.usdcContractAddress !== undefined)
    out.usdcContractAddress = camelRaw.usdcContractAddress;
  if (camelRaw.networkGraphEnabled !== undefined)
    out.networkGraphEnabled = camelRaw.networkGraphEnabled;
  if (camelRaw.copySimEnabled !== undefined) out.copySimEnabled = camelRaw.copySimEnabled;
  if (camelRaw.copySimSlippageBps !== undefined)
    out.copySimSlippageBps = camelRaw.copySimSlippageBps;
  if (camelRaw.copySimDelaySeconds !== undefined)
    out.copySimDelaySeconds = camelRaw.copySimDelaySeconds;
  if (camelRaw.regimeAdaptiveEnabled !== undefined)
    out.regimeAdaptiveEnabled = camelRaw.regimeAdaptiveEnabled;

  return out as unknown as ScannerConfig;
}

/** Deep-merge a YAML whale_tracking block into WhaleTrackingConfig defaults */
function buildWhaleConfig(raw: Record<string, unknown>): WhaleTrackingConfig {
  // Convert top-level snake_case keys
  const camelRaw = deepSnakeToCamel(raw) as Record<string, unknown>;

  // Extract and normalise nested objects before the shallow merge
  const scannerRaw = (camelRaw.scanner ?? {}) as Record<string, unknown>;
  delete camelRaw.scanner;

  const copyRaw = (camelRaw.copy ?? {}) as Record<string, unknown>;
  delete camelRaw.copy;

  const scoreWeightsRaw = (camelRaw.scoreWeights ?? {}) as Record<string, unknown>;
  delete camelRaw.scoreWeights;

  return {
    ...DEFAULT_WHALE_CONFIG,
    ...camelRaw,
    scoreWeights: { ...DEFAULT_WHALE_CONFIG.scoreWeights, ...scoreWeightsRaw },
    copy: { ...DEFAULT_WHALE_CONFIG.copy, ...copyRaw },
    scanner: normaliseScannerConfig(scannerRaw),
  } as WhaleTrackingConfig;
}

type ConfigDocument = {
  wallets?: Array<{ id: string; mode?: string; strategy?: string; capital?: number }>;
  [key: string]: unknown;
};

function writeState(state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readState(): Record<string, unknown> {
  if (!fs.existsSync(statePath)) {
    return { status: 'stopped' };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
}

program.name('bot').description('Polymarket multi-strategy trading platform').version('0.1.0');

program
  .command('start')
  .description('Start the trading engine')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .option('--record <file>', 'Also record market data to a replayable tape')
  .action(async (options: { config: string; record?: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    /* ── Durable wallet state ──
       LIVE wallets rebuild from the exchange; PAPER wallets have no other
       memory, so without this a restart throws away the experiment. */
    const db = new Database();
    await db.connect();
    for (const wallet of config.wallets) {
      const saved = db.loadWallet(wallet.id);
      if (!saved) continue;
      walletManager.getWallet(wallet.id)?.restore?.(saved.state, saved.trades);
    }

    const persistAll = (): void => {
      for (const state of walletManager.listWallets()) {
        const w = walletManager.getWallet(state.walletId);
        if (w) db.saveWallet(w.getState(), w.getTradeHistory());
      }
    };

    if (config.wallets.some((w) => w.mode === 'PAPER')) {
      logger.info(
        { fallbackRate: process.env.PAPER_FEE_RATE ?? '(none)' },
        'PAPER fills use each market\'s own fee schedule from Gamma; takers pay, makers do not',
      );
    }

    const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 3000);
    const dashboardServer = new DashboardServer(walletManager, dashboardPort);

    /* ── Whale Tracking Engine ── */
    const rawConfig = YAML.parse(fs.readFileSync(options.config, 'utf8')) as Record<
      string,
      unknown
    >;
    const whaleConfigRaw = (rawConfig.whale_tracking ?? {}) as Record<string, unknown>;
    const whaleConfig = buildWhaleConfig(whaleConfigRaw);
    logger.info(
      {
        scannerEnabled: whaleConfig.scanner.enabled,
        marketsPerScan: whaleConfig.scanner.marketsPerScan,
        minLiquidity: whaleConfig.scanner.minMarketLiquidityUsd,
        minVolume24h: whaleConfig.scanner.minMarketVolume24hUsd,
      },
      'Whale config loaded',
    );
    let whaleService: WhaleService | undefined;
    if (whaleConfig.enabled) {
      const clobApi = config.polymarket?.clobApi ?? 'https://clob.polymarket.com';
      const gammaApi = config.polymarket?.gammaApi ?? 'https://gamma-api.polymarket.com';
      whaleService = new WhaleService(whaleConfig, clobApi, gammaApi);
      const whaleApi = new WhaleAPI(whaleService);
      dashboardServer.setWhaleApi(whaleApi);
      whaleService.start();
      logger.info('Whale Tracking Engine active');
    }

    dashboardServer.start();
    const killSwitch = new KillSwitch();
    const riskEngine = new RiskEngine(killSwitch);
    const orderRouter = new OrderRouter(walletManager, riskEngine, new TradeExecutor());

    const engine = new Engine(config, walletManager, orderRouter);
    await engine.initialize();
    dashboardServer.setEngine(engine);
    dashboardServer.setKillSwitch(killSwitch);

    /* ── Paper wallets need the live book ──
       Without it nothing is marketable, so nothing fills.  Resting paper
       orders are worked on each snapshot, which is how paper market making
       gets filled (and adversely selected) at all. */
    const stream = engine.getStream();

    /* ── Real order books ──
       Gamma gives one aggregate liquidity number every 15s, which cannot
       answer whether an order fills. /books returns actual levels for many
       tokens in one POST, so it is polled far more often. */
    const bookSocket = new BookSocket();
    const bookFeed = new BookFeed(config.polymarket.clobApi);
    bookFeed.start();

    // Keep both feeds pointed at whatever is actually quoted right now.
    /* ── Tape recording ──
       A tee on the live feeds. Replaying the tape later fixes the market
       conditions, which is the only way to compare two parameter sets
       against each other rather than against different days. */
    const recorder = options.record ? new TapeRecorder(options.record) : undefined;
    recorder?.start();

    stream.on('snapshotBegin', () => {
      const markets = stream.getAllMarkets();
      const tokens = markets.flatMap((m) => m.clobTokenIds ?? []);
      bookFeed.track(tokens);
      bookSocket.subscribe(tokens);

      if (recorder) {
        recorder.recordSnapshot(markets);
        for (const token of tokens) {
          const book = bookFor(token);
          if (book) recorder.recordBook(book);
        }
      }
    });

    /* Socket first, REST second. The socket is push and current; the poller
       keeps books moving if it drops, rather than freezing them at the last
       value — a stale book is worse than a slow one. */
    const bookFor = (tokenId: string) =>
      (bookSocket.isHealthy() ? bookSocket.getBook(tokenId) : undefined) ?? bookFeed.getBook(tokenId);

    /* A hook, not a loop: wallets created later from the dashboard need the
       same feeds, and a one-shot pass leaves them with no book — which means
       nothing they order can ever fill. */
    walletManager.onWalletAdded((wallet) => {
      wallet.setFeeSource?.((marketId) => stream.getMarket(marketId)?.feeSchedule);
      wallet.setMarketSource?.((marketId) => {
        const m = stream.getMarket(marketId);
        if (!m) return undefined;
        // YES is token 0. Prefer live book prices over the 15s Gamma snapshot.
        const depth = bookFor(m.clobTokenIds?.[0] ?? '');
        return {
          bid: bestBid(depth) ?? m.bid,
          ask: bestAsk(depth) ?? m.ask,
          liquidity: m.liquidity,
          depth,
        };
      });
    });
    stream.on('update', (data) => {
      for (const state of walletManager.listWallets()) {
        walletManager.getWallet(state.walletId)?.onMarketUpdate?.(data);
      }
    });

    /* Marks for drawdown — cost basis cannot detect a loss. */
    riskEngine.setMarkPriceSource((marketId, outcome) => {
      const market = engine.getStream().getMarket(marketId);
      if (!market) return undefined;
      return market.outcomePrices[outcome === 'YES' ? 0 : 1];
    });

    /* A stop that leaves quotes working is not a stop. */
    killSwitch.onActivate(async (reason) => {
      logger.error({ reason }, 'Kill switch tripped — pulling all resting orders');
      for (const state of walletManager.listWallets()) {
        const wallet = walletManager.getWallet(state.walletId);
        if (!wallet?.cancelAllOrders) continue;
        try {
          await wallet.cancelAllOrders();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error(
            { walletId: state.walletId, error },
            `FAILED to cancel orders for ${state.walletId} after kill switch — CHECK THE BOOK`,
          );
          alert('critical', 'Kill switch fired but orders could NOT be cancelled', {
            walletId: state.walletId,
            error,
          });
        }
      }
    });

    /* ── Reconcile BEFORE the first quote ──
       On a cold start our books are empty but the exchange still holds the
       positions and resting orders from the last run.  Quoting before we
       have looked is trading blind. */
    const reconcileAll = async (phase: string): Promise<void> => {
      for (const state of walletManager.listWallets()) {
        const wallet = walletManager.getWallet(state.walletId);
        if (!wallet?.reconcile) continue;
        try {
          await wallet.reconcile();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error({ walletId: state.walletId, phase, error }, `Reconcile failed (${phase})`);
          alert('warning', 'Reconciliation failed — local books may be drifting', {
            walletId: state.walletId,
            phase,
            error,
          });
        }
      }
      persistAll();
    };

    /* ── Settlement ──
       A resolved market leaves the Gamma feed entirely (the snapshot query is
       active=true&closed=false), so a held position would otherwise sit at its
       entry price forever and the redemption would never reach PnL. */
    const settleResolved = async (): Promise<void> => {
      const live = new Set(stream.getAllMarkets().map((m) => m.marketId));

      for (const state of walletManager.listWallets()) {
        const wallet = walletManager.getWallet(state.walletId);
        if (!wallet?.settle) continue; // LIVE redeems on-chain

        const positions = wallet.getState().openPositions.map((p) => ({
          marketId: p.marketId,
          outcome: p.outcome,
        }));
        if (positions.length === 0) continue;

        try {
          const settlements = await findSettlements(positions, live, (ids) =>
            stream.fetchMarketsByIds(ids),
          );
          for (const s of settlements) {
            wallet.settle(s.marketId, s.outcome, s.price);
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error({ walletId: state.walletId, error }, 'Settlement check failed');
        }
      }
    };

    await reconcileAll('startup');
    await settleResolved();

    const reconcileMs = Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000);
    engine.setReconciler(async () => {
      await reconcileAll('periodic');
      await settleResolved();
    }, reconcileMs);
    logger.info({ reconcileMs }, 'Exchange reconciliation scheduled inside the tick loop');

    engine.start();

    writeState({ status: 'running', startedAt: new Date().toISOString() });

    /* ── Graceful shutdown ──
       Without this, Ctrl-C or a container restart strands live quotes on the
       book with nothing managing them. */
    let shuttingDown = false;
    const onSignal = async (signal: string): Promise<void> => {
      if (shuttingDown) return; // second Ctrl-C while cleanup is in flight
      shuttingDown = true;
      logger.warn({ signal }, `${signal} received — cancelling resting orders and shutting down`);

      // Hard deadline: never hang the process while orders sit on the book.
      const deadline = setTimeout(() => {
        logger.error('Shutdown timed out after 15s — forcing exit. CHECK FOR RESTING ORDERS.');
        process.exit(1);
      }, 15_000);

      recorder?.stop();
      bookSocket.close();
      bookFeed.stop();
      await gracefulShutdown({ engine, walletManager, dashboardServer, whaleService });
      persistAll();
      db.close();

      writeState({ status: 'stopped', stoppedAt: new Date().toISOString() });
      clearTimeout(deadline);
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => void onSignal('SIGINT'));
    process.on('SIGTERM', () => void onSignal('SIGTERM'));

    /* A crash is exactly when resting orders must come off the book, and the
       signal handlers do not cover it. Alert, cancel, then die — we do not
       keep trading after an unhandled fault. */
    const onFatal = (kind: string) => (err: unknown) => {
      const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger.fatal({ kind, error }, `${kind} — cancelling orders and exiting`);
      alert('critical', `Bot crashed (${kind}) — cancelling resting orders`, { error });
      killSwitch.activate(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
      void onSignal(kind);
    };
    process.on('uncaughtException', onFatal('uncaughtException'));
    process.on('unhandledRejection', onFatal('unhandledRejection'));
  });

program
  .command('replay')
  .description('Replay a recorded tape through the strategies — deterministic, no network')
  .requiredOption('-t, --tape <file>', 'Tape recorded by `start --record`')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action(async (options: { tape: string; config: string }) => {
    const config = loadConfig(options.config);

    // Replay must never touch the exchange, whatever the config says.
    config.environment.enableLiveTrading = false;
    for (const wallet of config.wallets) wallet.mode = 'PAPER';

    /* A replay that assumes zero fees flatters every strategy in it, and the
       flattery is invisible in the output. Gamma-sourced schedules still take
       precedence per market; this only covers markets that carried none. */
    if (!(Number(process.env.PAPER_FEE_RATE ?? 0) > 0)) {
      logger.warn(
        'PAPER_FEE_RATE is unset — markets with no fee schedule on the tape will be ' +
        'replayed with ZERO fees, overstating edge. Set it to the decimal rate from ' +
        'the fee table (0.04 politics, 0.05 sports, 0.07 crypto) before trusting results.',
      );
    }

    const events = readTape(options.tape);
    if (events.length === 0) {
      logger.error({ tape: options.tape }, 'Tape is empty — nothing to replay');
      process.exitCode = 1;
      return;
    }

    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, false);
    }

    const stream = new ReplayStream(events);
    const killSwitch = new KillSwitch();
    const riskEngine = new RiskEngine(killSwitch);
    const orderRouter = new OrderRouter(walletManager, riskEngine, new TradeExecutor());
    const engine = new Engine(config, walletManager, orderRouter, stream as never);

    // Books and fees come off the tape, exactly as they were recorded.
    walletManager.onWalletAdded((wallet) => {
      wallet.setFeeSource?.((marketId) => stream.getMarket(marketId)?.feeSchedule);
      wallet.setMarketSource?.((marketId) => {
        const m = stream.getMarket(marketId);
        if (!m) return undefined;
        const depth = stream.getBook(m.clobTokenIds?.[0] ?? '');
        return {
          bid: depth ? (bestBid(depth) ?? m.bid) : m.bid,
          ask: depth ? (bestAsk(depth) ?? m.ask) : m.ask,
          liquidity: m.liquidity,
          depth,
        };
      });
    });
    stream.on('update', (data) => {
      for (const state of walletManager.listWallets()) {
        walletManager.getWallet(state.walletId)?.onMarketUpdate?.(data);
      }
    });

    riskEngine.setMarkPriceSource((marketId, outcome) => {
      const m = stream.getMarket(marketId);
      return m?.outcomePrices[outcome === 'YES' ? 0 : 1];
    });

    await engine.initialize();

    const started = Date.now();
    let cycles = 0;
    while (stream.step()) {
      await engine.tickOnce();
      cycles++;
    }

    const elapsed = Date.now() - started;
    const span = events[events.length - 1].t - events[0].t;

    logger.info(
      {
        tape: options.tape,
        events: events.length,
        cycles,
        recordedSpanMinutes: Math.round(span / 60_000),
        replaySeconds: Math.round(elapsed / 1000),
      },
      'Replay complete',
    );

    /* ── Results, benchmarks alongside strategies ── */
    const rows = walletManager.listWallets().flatMap((state) => {
      const wallet = walletManager.getWallet(state.walletId);
      const fresh = wallet?.getState();
      if (!fresh) return [];

      const attribution = wallet?.getAttribution?.();
      const stats = wallet?.getSignificance?.();
      const history = wallet?.getTradeHistory() ?? [];
      const dd = drawdown(history, fresh.capitalAllocated);

      return [{
        walletId: fresh.walletId,
        strategy: fresh.assignedStrategy,
        isBenchmark: fresh.assignedStrategy.startsWith('benchmark_'),
        total: attribution?.total ?? fresh.realizedPnl,
        realizedPnl: fresh.realizedPnl,
        trades: history.length,
        openPositions: fresh.openPositions.length,
        attribution,
        stats,
        dd,
      }];
    });

    for (const r of rows) {
      logger.info(
        {
          walletId: r.walletId,
          strategy: r.strategy,
          realizedPnl: Number(r.realizedPnl.toFixed(4)),
          trades: r.trades,
          openPositions: r.openPositions,
          ...(r.attribution ? { attribution: describeAttribution(r.attribution) } : {}),
          ...(r.stats ? { verdict: r.stats.verdict } : {}),
          winRate: r.stats ? Number((r.stats.winRate * 100).toFixed(1)) : 0,
          maxDrawdownPct: Number((r.dd.maxDrawdownPct * 100).toFixed(2)),
        },
        `Replay result — ${r.walletId}`,
      );
    }

    /* ── Did it clear the bar it was asked to clear? ──
       Stated explicitly, per strategy wallet, so a miss is impossible to
       read as a pass. An underpowered sample is reported as UNPROVEN rather
       than PASSED: clearing a target over 11 trades is not clearing it. */
    const targetWinRate = Number(process.env.TARGET_WIN_RATE ?? 0.9);
    const targetMaxDd = Number(process.env.TARGET_MAX_DD ?? 0.1);

    const bar = rows
      .filter((r) => !r.isBenchmark && r.stats)
      .map((r) => {
        const winRate = r.stats!.winRate;
        const maxDd = r.dd.maxDrawdownPct;
        const misses: string[] = [];
        if (winRate < targetWinRate) misses.push('win rate');
        if (maxDd > targetMaxDd) misses.push('drawdown');

        const status = !r.stats!.significant
          ? `UNPROVEN (${r.stats!.samples} trades, too few to call)`
          : misses.length === 0
            ? 'PASSED'
            : `MISSED (${misses.join(' + ')})`;

        return `  ${r.walletId.padEnd(24)} winRate ${(winRate * 100).toFixed(1).padStart(5)}%  ` +
               `maxDD ${(maxDd * 100).toFixed(1).padStart(5)}%  ` +
               `target ${(targetWinRate * 100).toFixed(0)}%/${(targetMaxDd * 100).toFixed(0)}% → ${status}`;
      })
      .join('\n');

    if (bar) logger.info(`\nTarget bar:\n${bar}\n`);

    /* ── Did the strategies beat doing nothing clever? ──
       A strategy that cannot beat a random or naive baseline on the SAME
       tape is not earning its complexity. */
    const benchmarks = rows.filter((r) => r.isBenchmark);
    const strategies = rows.filter((r) => !r.isBenchmark);

    if (benchmarks.length > 0 && strategies.length > 0) {
      const best = Math.max(...benchmarks.map((b) => b.total));
      const bestName = benchmarks.find((b) => b.total === best)?.strategy ?? 'benchmark';

      const table = [...rows]
        .sort((a, b) => b.total - a.total)
        .map((r) => {
          const tag = r.isBenchmark ? 'BENCHMARK' : 'strategy ';
          const verdict = r.isBenchmark
            ? ''
            : r.total > best
              ? `  beats ${bestName} by $${(r.total - best).toFixed(2)}`
              : `  DOES NOT BEAT ${bestName} (short by $${(best - r.total).toFixed(2)})`;
          return `  ${tag}  ${r.walletId.padEnd(24)} $${r.total.toFixed(4).padStart(12)}  ${r.trades} trades${verdict}`;
        })
        .join('\n');

      logger.info(`\nBenchmark comparison (same tape, same conditions):\n${table}\n`);
    }
  });

program
  .command('stop')
  .description('Stop the trading engine')
  .action(() => {
    writeState({ status: 'stopped', stoppedAt: new Date().toISOString() });
    logger.info('Engine stop requested');
  });

program
  .command('status')
  .description('Get engine status')
  .action(() => {
    logger.info(readState());
  });

program
  .command('list-strategies')
  .description('List available strategies')
  .action(() => {
    logger.info({ strategies: listStrategies() });
  });

program
  .command('performance')
  .description('Show performance snapshot')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { config: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logger.info(
      computeAllPerformance(walletManager.listWallets(), walletManager.getAllTradeHistories()),
    );
  });

program
  .command('paper-report')
  .description('Show paper trading report')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { config: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logger.info({ paperWallets: walletManager.listWallets().filter((w) => w.mode === 'PAPER') });
  });

program
  .command('add-wallet')
  .description('Add a wallet to the config file')
  .requiredOption('--id <id>', 'Wallet id')
  .requiredOption('--strategy <strategy>', 'Strategy name')
  .option('--mode <mode>', 'Trading mode (PAPER|LIVE)', 'PAPER')
  .option('--capital <capital>', 'Capital allocation', '0')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action(
    (options: { id: string; strategy: string; mode: string; capital: string; config: string }) => {
      const raw = fs.readFileSync(options.config, 'utf8');
      const parsed = YAML.parse(raw) as ConfigDocument;
      parsed.wallets = parsed.wallets ?? [];
      parsed.wallets.push({
        id: options.id,
        mode: options.mode,
        strategy: options.strategy,
        capital: Number(options.capital),
      });
      fs.writeFileSync(options.config, YAML.stringify(parsed));
      logger.info({ walletId: options.id }, 'Wallet added');
    },
  );

program
  .command('remove-wallet')
  .description('Remove a wallet from the config file')
  .requiredOption('--id <id>', 'Wallet id')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { id: string; config: string }) => {
    const raw = fs.readFileSync(options.config, 'utf8');
    const parsed = YAML.parse(raw) as ConfigDocument;
    parsed.wallets = (parsed.wallets ?? []).filter((wallet) => wallet.id !== options.id);
    fs.writeFileSync(options.config, YAML.stringify(parsed));
    logger.info({ walletId: options.id }, 'Wallet removed');
  });

program.parseAsync(process.argv);
