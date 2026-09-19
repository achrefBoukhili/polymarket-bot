/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Polymarket trading fees.

   Per the docs (docs.polymarket.com/trading/fees):

       fee = C × feeRate × p × (1 − p)

   where C is shares and p is price.  Two properties follow, and
   both matter more than the formula itself:

   • MAKERS PAY NOTHING.  Only takers are charged.  A market
     maker whose resting quote is hit pays zero — charging it
     makes market making look far worse than it is.
   • The fee is symmetric about 50¢: a trade at 30¢ costs the
     same as one at 70¢, and it peaks at 50¢.

   Rates are per market, not global.  Gamma serves them directly
   on each market (feeSchedule.rate, takerOnly, feesEnabled), so
   nothing here is hardcoded or guessed from a category.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface FeeSchedule {
  /** Decimal rate, e.g. 0.05 for sports, 0.04 for politics. */
  rate: number;
  /** Exponent applied to p(1−p). Gamma currently serves 1. */
  exponent?: number;
  /** When true (the norm), makers are not charged. */
  takerOnly?: boolean;
  /** False on fee-free markets, e.g. geopolitics. */
  enabled?: boolean;
  /** Share of collected taker fees redistributed to makers (0.15–0.25). */
  rebateRate?: number;
}

/**
 * Fee in USDC for one fill.
 *
 * `isTaker` decides whether anything is owed at all on a takerOnly schedule,
 * which is nearly all of them.
 */
export function tradeFee(
  price: number,
  size: number,
  schedule: FeeSchedule | undefined,
  isTaker: boolean,
): number {
  if (!schedule || schedule.enabled === false) return 0;
  if (!(schedule.rate > 0) || !(size > 0)) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;

  // Makers are not charged on a takerOnly schedule.
  if (schedule.takerOnly !== false && !isTaker) return 0;

  const curve = price * (1 - price);
  const exponent = schedule.exponent ?? 1;
  return size * schedule.rate * (exponent === 1 ? curve : curve ** exponent);
}

/**
 * Build a schedule from the basis-point rate the CLOB reports on a trade.
 * The exchange has already applied maker/taker logic by then — a maker fill
 * simply carries 0 — so this is charged as-is.
 */
export function scheduleFromBps(feeRateBps: number | undefined): FeeSchedule | undefined {
  const bps = Number(feeRateBps);
  if (!Number.isFinite(bps) || bps <= 0) return undefined;
  return { rate: bps / 10_000, exponent: 1, takerOnly: false, enabled: true };
}

/**
 * Fallback schedule for PAPER fills in markets where Gamma served no fee
 * parameters. Defaults to off; set PAPER_FEE_RATE to the decimal rate from
 * the fee table (0.05 sports, 0.04 politics, 0.07 crypto) to assume one.
 */
export function paperFallbackSchedule(): FeeSchedule | undefined {
  const rate = Number(process.env.PAPER_FEE_RATE ?? 0);
  if (!(rate > 0)) return undefined;
  return { rate, exponent: 1, takerOnly: true, enabled: true };
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Maker rebates (docs.polymarket.com/programs/maker-rebates).

   The pool is share-weighted, which looks like it needs
   market-wide data:

       fee_equivalent = C × feeRate × p × (1 − p)
       rebate = (your_fee_eq / total_fee_eq) × rebate_pool

   But the pool IS rebateRate × the taker fees collected, and
   every match has equal shares on both sides — so the maker
   fee-equivalent summed across everyone equals the taker fees
   collected. The total cancels:

       rebate = your_fee_equivalent × rebateRate

   which is computable from our own fills alone, exactly, with
   no assumption about anyone else's volume.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Rebate accrued by one MAKER fill. Takers earn nothing here. */
export function makerRebate(
  price: number,
  size: number,
  schedule: FeeSchedule | undefined,
  isTaker: boolean,
): number {
  if (isTaker || !schedule || schedule.enabled === false) return 0;
  const rebateRate = schedule.rebateRate ?? 0;
  if (!(rebateRate > 0) || !(schedule.rate > 0) || !(size > 0)) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;

  // Same fee curve, by design — that is what "fee-curve weighted" means.
  const curve = price * (1 - price);
  const exponent = schedule.exponent ?? 1;
  const feeEquivalent = size * schedule.rate * (exponent === 1 ? curve : curve ** exponent);
  return feeEquivalent * rebateRate;
}

/** Rebates below this do not pay out. */
export const REBATE_MIN_PAYOUT_USD = 1;
