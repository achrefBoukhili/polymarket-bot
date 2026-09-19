import { logger } from '../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Settlement.

   When a Polymarket market resolves, winning shares redeem for
   $1 and losing shares for $0.  That redemption is not a CLOB
   trade, so it never appears in getTrades() — and the market
   drops out of the Gamma feed, so strategies stop seeing it too.
   Without this, a resolved position sits in the books forever at
   its entry price and the payout never lands in PnL.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface ResolvableMarket {
  id: string;
  closed?: boolean;
  /** JSON string of the final prices, e.g. '["1","0"]'. */
  outcomePrices?: string;
}

export interface Settlement {
  marketId: string;
  outcome: 'YES' | 'NO';
  /** 1 for the winning side, 0 for the losing side. */
  price: number;
}

/** Parse Gamma's stringified price array without throwing on junk. */
function parsePrices(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * The settlement price for one side of a resolved market.
 *
 * Returns undefined when the market is not closed, or is closed but has not
 * actually resolved to a definite outcome yet — a price still sitting near
 * 0.5 means the oracle has not spoken, and settling on it would invent PnL.
 */
export function settlementPrice(
  market: ResolvableMarket,
  outcome: 'YES' | 'NO',
): number | undefined {
  if (!market.closed) return undefined;

  const prices = parsePrices(market.outcomePrices);
  if (prices.length < 1) return undefined;

  const yes = prices[0];
  const no = prices[1] ?? 1 - yes;

  // A resolved binary market pays 1/0. Anything else is still in flight.
  const resolved =
    (Math.abs(yes - 1) < 0.01 && Math.abs(no) < 0.01) ||
    (Math.abs(yes) < 0.01 && Math.abs(no - 1) < 0.01);
  if (!resolved) return undefined;

  const price = outcome === 'YES' ? yes : no;
  return price > 0.5 ? 1 : 0;
}

/**
 * Which held positions belong to markets that have left the live feed and
 * turned out to be resolved.
 *
 * `liveMarketIds` is the current snapshot: a position whose market is still
 * quoted is by definition not settled, so we never look it up.
 */
export async function findSettlements(
  positions: Array<{ marketId: string; outcome: 'YES' | 'NO' }>,
  liveMarketIds: Set<string>,
  lookup: (ids: string[]) => Promise<ResolvableMarket[]>,
): Promise<Settlement[]> {
  const missing = positions.filter((p) => !liveMarketIds.has(p.marketId));
  if (missing.length === 0) return [];

  const markets = await lookup([...new Set(missing.map((p) => p.marketId))]);
  const byId = new Map(markets.map((m) => [String(m.id), m]));

  const settlements: Settlement[] = [];
  for (const pos of missing) {
    const market = byId.get(pos.marketId);
    if (!market) {
      // Gone from the feed and not findable: do not guess a payout.
      logger.warn({ marketId: pos.marketId }, 'Held position has no market data — cannot settle yet');
      continue;
    }
    const price = settlementPrice(market, pos.outcome);
    if (price === undefined) continue;
    settlements.push({ marketId: pos.marketId, outcome: pos.outcome, price });
  }
  return settlements;
}
