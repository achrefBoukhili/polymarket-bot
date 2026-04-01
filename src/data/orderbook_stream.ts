import { EventEmitter } from 'events';
import { MarketData } from '../types';
import { MarketFetcher } from './market_fetcher';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

/**
 * Polls the Polymarket Gamma API at a configurable interval and emits
 * real MarketData updates for every tracked market.
 */
export class OrderbookStream extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private readonly fetcher: MarketFetcher;
  private readonly pollMs: number;
  /**
   * Current snapshot of live markets keyed by marketId.
   * Rebuilt from scratch on every poll — size always equals the number of
   * currently active markets, so closed markets are evicted automatically.
   */
  private cache = new Map<string, MarketData>();
  private pollCount = 0;
  private isPolling = false;

  constructor(gammaApi?: string, pollMs = 15_000) {
    super();
    // No limit — fetches all active markets every poll; memory stays flat
    // because the cache is replaced, not accumulated, on each cycle.
    this.fetcher = new MarketFetcher(gammaApi);
    this.pollMs = pollMs;
  }

  /** Start polling. First poll fires immediately. */
  start(): void {
    if (this.timer) return;
    // Fire immediately, then at interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    logger.info({ pollMs: this.pollMs }, 'OrderbookStream started (live Gamma polling)');
    consoleLog.success(
      'SCAN',
      `OrderbookStream started — polling Gamma every ${this.pollMs / 1000}s`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('OrderbookStream stopped');
      consoleLog.warn('SCAN', 'OrderbookStream stopped');
    }
  }

  getMarket(marketId: string): MarketData | undefined {
    return this.cache.get(marketId);
  }

  getAllMarkets(): MarketData[] {
    return [...this.cache.values()];
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return; // Prevent overlapping API requests and infinite memory loops
    this.isPolling = true;

    try {
      const markets = await this.fetcher.fetchSnapshot();

      // ── Snapshot-swap: replace the cache wholesale rather than accumulating.
      // Any market that is no longer returned by the API (closed, inactive)
      // simply disappears from the cache — no TTL bookkeeping needed.
      // Emit 'snapshotBegin' first so listeners (strategies) can clear their
      // own stale state before receiving the fresh per-market update events.
      this.emit('snapshotBegin', markets.length);
      this.cache.clear();
      for (const m of markets) {
        this.cache.set(m.marketId, m);
        this.emit('update', m);
      }
      this.pollCount++;
      consoleLog.info(
        'SCAN',
        `Poll #${this.pollCount} complete — ${markets.length} markets fetched & cached`,
        {
          pollNumber: this.pollCount,
          fetched: markets.length,
          cached: this.cache.size,
        },
      );
    } catch (error) {
      logger.error({ error }, 'OrderbookStream poll failed');
      const msg = error instanceof Error ? error.message : String(error);
      consoleLog.error('SCAN', `Poll failed: ${msg}`, { error: msg });
    } finally {
      this.isPolling = false;
    }
  }
}
