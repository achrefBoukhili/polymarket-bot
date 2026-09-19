import { tradeFee, scheduleFromBps } from '../execution/fees';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Reconciliation — pure functions that turn exchange truth into
   local state.  No network here, so the accounting is testable.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** A single fill from OUR side of a trade. */
export interface NormalizedFill {
  fillId: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
  /** Fee rate the exchange applied to this fill. */
  feeRateBps: number;
  /** Were we the taker? Makers are not charged. */
  isTaker: boolean;
}

/** The subset of the CLOB Trade shape this module reads. */
export interface RawTrade {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  match_time: string;
  outcome: string;
  fee_rate_bps?: string;
  trader_side?: 'TAKER' | 'MAKER';
  maker_orders?: Array<{
    order_id: string;
    maker_address: string;
    matched_amount: string;
    price: string;
    asset_id: string;
    outcome: string;
    side: string;
    fee_rate_bps?: string;
  }>;
}

/** Trades in these states never settled and must not move our books. */
const DEAD_STATUSES = new Set(['failed', 'retrying']);

function parseTimestamp(matchTime: string): number {
  // The CLOB sends unix seconds as a string; tolerate ISO just in case.
  const asNumber = Number(matchTime);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000;
  const parsed = Date.parse(matchTime);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extract our own fills from a trade.
 *
 * This is the subtle one.  When we are the MAKER, the top-level side/size/
 * price describe the TAKER's side of the match — reading them would invert
 * every position we hold.  Our real fills live in maker_orders[], and a
 * single match can include other makers too, so we filter by address.
 */
export function normalizeTrade(trade: RawTrade, ourAddresses: Set<string>): NormalizedFill[] {
  if (DEAD_STATUSES.has(String(trade.status ?? '').toLowerCase())) return [];

  const timestamp = parseTimestamp(trade.match_time);

  if (trade.trader_side === 'MAKER') {
    const mine = (trade.maker_orders ?? []).filter((o) =>
      ourAddresses.has(String(o.maker_address ?? '').toLowerCase()),
    );
    return mine.map((o) => ({
      fillId: `${trade.id}:${o.order_id}`,
      tokenId: o.asset_id,
      conditionId: trade.market,
      outcome: o.outcome,
      side: String(o.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(o.price),
      size: Number(o.matched_amount),
      timestamp,
      feeRateBps: Number(o.fee_rate_bps ?? 0) || 0,
      isTaker: false, // these are our maker orders, by definition
    }));
  }

  return [
    {
      fillId: trade.id,
      tokenId: trade.asset_id,
      conditionId: trade.market,
      outcome: trade.outcome,
      side: String(trade.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(trade.price),
      size: Number(trade.size),
      timestamp,
      feeRateBps: Number(trade.fee_rate_bps ?? 0) || 0,
      isTaker: true,
    },
  ];
}

export interface RebuiltPosition {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  realizedPnl: number;
}

/**
 * Replay fills into positions, keyed by token id — the only id the exchange
 * and our market cache agree on (Gamma market ids are not CLOB condition ids).
 *
 * Rebuilt from scratch every cycle, so applying the same trade twice is
 * impossible by construction and no dedup bookkeeping is needed.
 *
 * Weighted-average cost basis, matching the optimistic path in the wallets.
 */
export function rebuildPositions(fills: NormalizedFill[]): {
  positions: RebuiltPosition[];
  /** Net of fees — this is what the wallet reports. */
  realizedPnl: number;
  /** Before fees, for seeing what the venue took. */
  grossRealizedPnl: number;
  /** Fees paid across every fill, entry and exit alike. */
  fees: number;
} {
  const ordered = [...fills]
    .filter((f) => Number.isFinite(f.size) && f.size > 0 && Number.isFinite(f.price))
    .sort((a, b) => a.timestamp - b.timestamp || a.fillId.localeCompare(b.fillId));

  const book = new Map<string, RebuiltPosition>();
  let realizedPnl = 0;
  let fees = 0;

  for (const fill of ordered) {
    // Charged on taker fills only — a maker fill carries a 0 rate anyway,
    // but being explicit keeps the two paths honest.
    fees += tradeFee(fill.price, fill.size, scheduleFromBps(fill.feeRateBps), fill.isTaker);

    const pos = book.get(fill.tokenId) ?? {
      tokenId: fill.tokenId,
      conditionId: fill.conditionId,
      outcome: fill.outcome,
      size: 0,
      avgPrice: 0,
      realizedPnl: 0,
    };

    if (fill.side === 'BUY') {
      const newSize = pos.size + fill.size;
      pos.avgPrice = (pos.avgPrice * pos.size + fill.price * fill.size) / newSize;
      pos.size = newSize;
    } else {
      // Only realise against shares we actually held.  Any excess is proceeds
      // with no basis — it means our view drifted, so it is worth seeing.
      const closed = Math.min(fill.size, pos.size);
      const pnl = (fill.price - pos.avgPrice) * closed + fill.price * (fill.size - closed);
      pos.realizedPnl += pnl;
      realizedPnl += pnl;
      pos.size -= closed;
      if (pos.size <= 0) {
        pos.size = 0;
        pos.avgPrice = 0;
      }
    }

    book.set(fill.tokenId, pos);
  }

  return {
    positions: [...book.values()].filter((p) => p.size > 0),
    realizedPnl: realizedPnl - fees,
    grossRealizedPnl: realizedPnl,
    fees,
  };
}

/**
 * Cash we may actually commit to a new order.
 *
 * Bounded by BOTH the real on-chain balance (a hard ceiling — you cannot
 * spend money you do not have) and the capital the operator allocated to
 * this wallet (a soft ceiling they chose), less collateral already committed
 * to resting orders.
 */
export function computeAvailableBalance(input: {
  chainCash: number;
  capitalAllocated: number;
  positionCost: number;
  reservedCollateral: number;
}): number {
  const allocationLeft = Math.max(0, input.capitalAllocated - input.positionCost);
  return Math.max(0, Math.min(input.chainCash, allocationLeft) - input.reservedCollateral);
}

/** USDC is 6-decimal; the CLOB reports balances in base units. */
export function parseUsdc(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed / 1e6 : 0;
}
