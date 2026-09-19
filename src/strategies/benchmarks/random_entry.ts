import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest } from '../../types';
import { makeRng, BENCHMARK_SEED } from './prng';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   NULL BENCHMARK — random entry.

   Picks markets and sides at random, at a comparable cadence to
   a real strategy, and exits on a fixed timer. It has no view on
   anything.

   If a strategy with filters, scoring and signal logic does not
   beat this on the same tape, those filters are not earning
   their complexity — they are just an expensive way to pick at
   random.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class RandomEntryStrategy extends BaseStrategy {
  readonly name = 'benchmark_random';

  private rng = makeRng(BENCHMARK_SEED);
  /** Chance of opening a position on any given evaluation. */
  private entryProbability = 0.05;
  private maxOpen = 10;
  private holdMs = 30 * 60_000;

  private open = new Map<string, { outcome: 'YES' | 'NO'; size: number; entryTime: number }>();

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const cfg = context.config as Record<string, number>;
    if (cfg.entryProbability) this.entryProbability = cfg.entryProbability;
    if (cfg.maxOpen) this.maxOpen = cfg.maxOpen;
    if (cfg.holdMinutes) this.holdMs = cfg.holdMinutes * 60_000;
    if (cfg.seed) this.rng = makeRng(cfg.seed);
    logger.info({ strategy: this.name, seed: BENCHMARK_SEED }, 'Random-entry benchmark initialised');
  }

  generateSignals(): Signal[] {
    if (this.open.size >= this.maxOpen) return [];

    const signals: Signal[] = [];
    // Iterate in a stable order so the same tape gives the same draws.
    const markets = [...this.markets.values()].sort((a, b) => a.marketId.localeCompare(b.marketId));

    for (const market of markets) {
      if (this.open.size + signals.length >= this.maxOpen) break;
      if (this.open.has(market.marketId)) continue;
      if (this.rng() > this.entryProbability) continue;

      signals.push({
        marketId: market.marketId,
        outcome: this.rng() < 0.5 ? 'YES' : 'NO',
        side: 'BUY',
        confidence: 1, // no view, so no basis for varying conviction
        edge: 0,
      });
    }
    return signals;
  }

  override notifyFill(order: OrderRequest): void {
    super.notifyFill(order);
    if (order.side === 'BUY') {
      this.open.set(order.marketId, {
        outcome: order.outcome,
        size: order.size,
        entryTime: Date.now(),
      });
    }
  }

  override managePositions(): void {
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    for (const [marketId, pos] of this.open) {
      if (Date.now() - pos.entryTime < this.holdMs) continue;
      const market = this.markets.get(marketId);
      if (!market) continue;

      const price = pos.outcome === 'YES' ? market.bid : 1 - market.ask;
      this.queueExit(
        {
          walletId,
          marketId,
          outcome: pos.outcome,
          side: 'SELL',
          price: Number(Math.max(0.01, Math.min(0.99, price)).toFixed(2)),
          size: pos.size,
          strategy: this.name,
        },
        (filled) => {
          pos.size -= filled;
          if (pos.size <= 0) this.open.delete(marketId);
        },
      );
    }
  }
}
