import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest } from '../../types';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   NULL BENCHMARK — buy and hold.

   Buy YES once in the most liquid markets and never trade again.
   No exits, no management, no timing.

   This is the bar for any directional strategy: if all the
   signal work does not beat simply being long the favourites,
   the trading is subtracting value.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class BuyAndHoldStrategy extends BaseStrategy {
  readonly name = 'benchmark_buy_and_hold';

  private maxMarkets = 10;
  private minLiquidity = 1000;
  private held = new Set<string>();

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const cfg = context.config as Record<string, number>;
    if (cfg.maxMarkets) this.maxMarkets = cfg.maxMarkets;
    if (cfg.minLiquidity) this.minLiquidity = cfg.minLiquidity;
    logger.info({ strategy: this.name }, 'Buy-and-hold benchmark initialised');
  }

  generateSignals(): Signal[] {
    if (this.held.size >= this.maxMarkets) return [];

    return [...this.markets.values()]
      .filter((m) => m.liquidity >= this.minLiquidity && !this.held.has(m.marketId))
      .sort((a, b) => b.liquidity - a.liquidity || a.marketId.localeCompare(b.marketId))
      .slice(0, this.maxMarkets - this.held.size)
      .map((m) => ({
        marketId: m.marketId,
        outcome: 'YES' as const,
        side: 'BUY' as const,
        confidence: 1,
        edge: 0,
      }));
  }

  override notifyFill(order: OrderRequest): void {
    super.notifyFill(order);
    if (order.side === 'BUY') this.held.add(order.marketId);
  }

  /** Hold means hold. Positions resolve or they do not. */
  override managePositions(): void {
    return;
  }
}
