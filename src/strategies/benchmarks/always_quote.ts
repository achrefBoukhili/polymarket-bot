import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest } from '../../types';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   NULL BENCHMARK — always quote.

   The dumbest market maker that could work: quote both sides at
   a fixed offset from mid, on the most liquid markets, forever.
   No inventory skew, no volatility widening, no adverse-
   selection guard, no market selection beyond "liquid".

   This is the bar for `spread_enhanced` and `market_making`. If
   all their machinery does not beat quoting blindly on the same
   tape, the machinery is decoration.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class AlwaysQuoteStrategy extends BaseStrategy {
  readonly name = 'benchmark_always_quote';
  readonly replacesQuotes = true;

  private halfSpread = 0.02;
  private maxMarkets = 8;
  private minLiquidity = 1000;
  private quoteSize = 10;

  protected override cooldownMs = 30_000;

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const cfg = context.config as Record<string, number>;
    if (cfg.halfSpread) this.halfSpread = cfg.halfSpread;
    if (cfg.maxMarkets) this.maxMarkets = cfg.maxMarkets;
    if (cfg.minLiquidity) this.minLiquidity = cfg.minLiquidity;
    if (cfg.quoteSize) this.quoteSize = cfg.quoteSize;
    logger.info({ strategy: this.name }, 'Always-quote benchmark initialised');
  }

  generateSignals(): Signal[] {
    // Most liquid first, ties broken by id so the tape replays identically.
    const markets = [...this.markets.values()]
      .filter((m) => m.liquidity >= this.minLiquidity)
      .sort((a, b) => b.liquidity - a.liquidity || a.marketId.localeCompare(b.marketId))
      .slice(0, this.maxMarkets);

    // One bid per market. No skew, no view — that is the point.
    return markets.map((m) => ({
      marketId: m.marketId,
      outcome: 'YES' as const,
      side: 'BUY' as const,
      confidence: 1,
      edge: 0,
    }));
  }

  override sizePositions(signals: Signal[]): OrderRequest[] {
    return super.sizePositions(signals).map((order) => {
      const market = this.markets.get(order.marketId);
      if (!market) return order;

      const mid = (market.bid + market.ask) / 2;
      const price = Number(Math.max(0.01, Math.min(0.99, mid - this.halfSpread)).toFixed(2));
      return { ...order, price, size: this.quoteSize };
    });
  }

  override managePositions(): void {
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Flat exit rule: offer inventory back at mid + halfSpread.
    for (const pos of this.context?.wallet.openPositions ?? []) {
      const market = this.markets.get(pos.marketId);
      if (!market || pos.size <= 0) continue;

      const mid = (market.bid + market.ask) / 2;
      this.queueExit(
        {
          walletId,
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: 'SELL',
          price: Number(Math.max(0.01, Math.min(0.99, mid + this.halfSpread)).toFixed(2)),
          size: pos.size,
          strategy: this.name,
        },
        () => {
          /* The wallet is the book of record; nothing local to release. */
        },
      );
    }
  }
}
