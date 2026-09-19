import { WalletState, TradeRecord } from '../types';
import { computePerformance, PerformanceSnapshot } from './dashboard_api';
import { significance, perTradePnl, drawdown, type Significance, type Drawdown } from './statistics';

export type { PerformanceSnapshot };

/**
 * Performance per wallet, with the trades it was actually computed from.
 *
 * This used to call computePerformance(w, [], 0) — an empty trade array —
 * so every snapshot was derived from no data at all.
 */
export function computeAllPerformance(
  wallets: WalletState[],
  tradesByWallet: Map<string, TradeRecord[]> = new Map(),
  marketPrices: Map<string, number> = new Map(),
): Array<PerformanceSnapshot & { significance: Significance; drawdown: Drawdown }> {
  return wallets.map((w) => {
    const trades = tradesByWallet.get(w.walletId) ?? [];
    const unrealised = w.openPositions.reduce((sum, p) => {
      const mark = marketPrices.get(p.marketId);
      return mark === undefined ? sum : sum + (mark - p.avgPrice) * p.size;
    }, 0);

    return {
      ...computePerformance(w, trades, unrealised),
      significance: significance(perTradePnl(trades)),
      drawdown: drawdown(trades, w.capitalAllocated),
    };
  });
}
