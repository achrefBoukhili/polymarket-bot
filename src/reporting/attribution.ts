/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Where the PnL came from.

   Aggregate PnL says whether a strategy worked. It never says
   why, which is the only part you can act on. "Captured $100 of
   spread and gave $120 back to adverse selection" tells you to
   quote wider; "lost $20" tells you nothing.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface AttributedFill {
  fillId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  /** Mid price at the moment of the fill. */
  mid: number;
  /** True when we crossed the spread. */
  isTaker: boolean;
  fee: number;
  rebate: number;
  timestamp: number;
}

export interface Attribution {
  /** Edge captured against mid at fill time — the maker's raw earning. */
  spreadCapture: number;
  /** Mid movement against us after filling. The maker's raw cost. */
  adverseSelection: number;
  /** Taker fees paid. */
  fees: number;
  /** Maker rebates earned. */
  rebates: number;
  /** PnL from positions still open, marked to current mid. */
  inventoryCarry: number;
  /** PnL booked at market resolution. */
  settlement: number;
  /** Sum of the parts. */
  total: number;
  /** Fills whose markout horizon has not elapsed yet. */
  pendingMarkouts: number;
}

/** How long after a fill we measure mid movement. */
export const MARKOUT_HORIZON_MS = 60_000;

/**
 * Accumulates fills and later mid observations, and reports the split.
 *
 * Adverse selection is measured as a markout: where the mid went in the
 * MARKOUT_HORIZON_MS after we filled. If we buy and the mid falls, that
 * move is the cost of having been picked off, and it is the number that
 * decides whether a market-making strategy is viable.
 */
export class AttributionTracker {
  private spreadCapture = 0;
  private adverseSelection = 0;
  private fees = 0;
  private rebates = 0;
  private settlement = 0;

  /** Fills waiting for their markout horizon to elapse. */
  private pending: Array<AttributedFill & { direction: 1 | -1 }> = [];

  /** Latest mid per market, for carry and for resolving markouts. */
  private readonly mids = new Map<string, number>();

  recordFill(fill: AttributedFill): void {
    this.fees += fill.fee;
    this.rebates += fill.rebate;

    // Buying below mid, or selling above it, is captured edge.
    const direction: 1 | -1 = fill.side === 'BUY' ? 1 : -1;
    this.spreadCapture += (fill.mid - fill.price) * direction * fill.size;

    this.mids.set(fill.marketId, fill.mid);
    this.pending.push({ ...fill, direction });
  }

  /** Settlement PnL is its own bucket — it is not spread or selection. */
  recordSettlement(pnl: number): void {
    this.settlement += pnl;
  }

  /**
   * Feed a fresh mid. Fills past their horizon are marked out and retired.
   */
  observeMid(marketId: string, mid: number, now = Date.now()): void {
    if (!Number.isFinite(mid)) return;
    this.mids.set(marketId, mid);

    const stillPending: typeof this.pending = [];
    for (const fill of this.pending) {
      if (now - fill.timestamp < MARKOUT_HORIZON_MS) {
        stillPending.push(fill);
        continue;
      }
      if (fill.marketId !== marketId) {
        stillPending.push(fill); // needs a mid for its own market
        continue;
      }
      // Mid moving against our direction is the cost of being selected.
      this.adverseSelection += (mid - fill.mid) * fill.direction * fill.size;
    }
    this.pending = stillPending;
  }

  /**
   * @param openPositions marked at the latest mid we have seen
   */
  snapshot(openPositions: Array<{ marketId: string; size: number; avgPrice: number }> = []): Attribution {
    let inventoryCarry = 0;
    for (const p of openPositions) {
      const mid = this.mids.get(p.marketId);
      if (mid === undefined) continue; // unpriced: do not invent carry
      inventoryCarry += (mid - p.avgPrice) * p.size;
    }

    const total =
      this.spreadCapture + this.adverseSelection - this.fees + this.rebates +
      inventoryCarry + this.settlement;

    return {
      spreadCapture: this.spreadCapture,
      adverseSelection: this.adverseSelection,
      fees: this.fees,
      rebates: this.rebates,
      inventoryCarry,
      settlement: this.settlement,
      total,
      pendingMarkouts: this.pending.length,
    };
  }
}

/** One-line summary for logs and the dashboard. */
export function describeAttribution(a: Attribution): string {
  const sign = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(4);
  return [
    `spread ${sign(a.spreadCapture)}`,
    `adverse ${sign(a.adverseSelection)}`,
    `fees -$${a.fees.toFixed(4)}`,
    `rebates ${sign(a.rebates)}`,
    `carry ${sign(a.inventoryCarry)}`,
    `settle ${sign(a.settlement)}`,
    `= ${sign(a.total)}`,
  ].join('  ');
}
