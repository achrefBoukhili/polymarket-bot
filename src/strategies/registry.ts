import { StrategyInterface } from './strategy_interface';
import { CrossMarketArbitrageStrategy } from './arbitrage/cross_market_arbitrage';
import { MispricingArbitrageStrategy } from './arbitrage/mispricing_detector';
import { AiForecastStrategy } from './research_ai/ai_forecast_strategy';
import { SpreadStrategy } from './market_making/spread_strategy';
import { MomentumStrategy } from './trend/momentum_strategy';
import { UserDefinedStrategy } from './custom/user_defined_strategy';
import { FilteredHighProbConvergenceStrategy } from './convergence/filtered_high_prob_convergence';
import { CopyTradeStrategy } from './copy_trading/copy_trade_strategy';
import { SpreadEnhancedStrategy } from './market_making/enhanced_liniar_invantory';
import { RandomEntryStrategy } from './benchmarks/random_entry';
import { AlwaysQuoteStrategy } from './benchmarks/always_quote';
import { BuyAndHoldStrategy } from './benchmarks/buy_and_hold';
// import { EnhancedLinearInventoryStrategyV2 } from './market_making/enhanced_liniar_invantory_V2';

export const STRATEGY_REGISTRY: Record<string, new () => StrategyInterface> = {
  cross_market_arbitrage: CrossMarketArbitrageStrategy,
  mispricing_arbitrage: MispricingArbitrageStrategy,
  ai_forecast: AiForecastStrategy,
  market_making: SpreadStrategy,
  momentum: MomentumStrategy,
  user_defined: UserDefinedStrategy,
  filtered_high_prob_convergence: FilteredHighProbConvergenceStrategy,
  copy_trade: CopyTradeStrategy,
  spread_enhanced: SpreadEnhancedStrategy,

  /* ── Null benchmarks ──
     Not strategies: baselines to measure strategies against on the same
     tape. A strategy that cannot beat these is not earning its complexity. */
  benchmark_random: RandomEntryStrategy,
  benchmark_always_quote: AlwaysQuoteStrategy,
  benchmark_buy_and_hold: BuyAndHoldStrategy,
  // enhanced_linear_inventory_v2: EnhancedLinearInventoryStrategyV2,
};

export function listStrategies(): string[] {
  return Object.keys(STRATEGY_REGISTRY);
}
