/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Is this result real, or is it noise?

   A strategy up $50 over 20 trades tells you nothing, but a
   dashboard that shows "+$50" invites you to believe it. These
   are the numbers that separate "it works" from "I cannot tell
   yet".
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface Significance {
  /** Closed trades the statistics are based on. */
  samples: number;
  /** Mean PnL per trade. */
  expectancy: number;
  /** Standard deviation of per-trade PnL. */
  stdDev: number;
  /** Standard error of the mean. */
  stdError: number;
  /** Expectancy in standard errors — |t| ≳ 2 is the usual bar. */
  tStat: number;
  /** 95% confidence interval for expectancy. */
  ci95: [number, number];
  /** Per-trade Sharpe (expectancy / stdDev). Not annualised. */
  sharpe: number;
  /** Fraction of trades that made money. */
  winRate: number;
  /** Gross wins / gross losses. */
  profitFactor: number;
  /**
   * Whether the mean is distinguishable from zero at ~95%.
   * False when the sample is too small to say either way.
   */
  significant: boolean;
  /** Plain-language reading, so the number is not misread. */
  verdict: string;
}

/** Below this, the t-statistic is not worth quoting. */
const MIN_SAMPLES = 30;

export function significance(perTradePnl: number[]): Significance {
  const samples = perTradePnl.length;

  if (samples === 0) {
    return {
      samples: 0, expectancy: 0, stdDev: 0, stdError: 0, tStat: 0, ci95: [0, 0],
      sharpe: 0, winRate: 0, profitFactor: 0, significant: false,
      verdict: 'No closed trades yet — nothing to measure.',
    };
  }

  const expectancy = perTradePnl.reduce((a, b) => a + b, 0) / samples;

  // Sample standard deviation (n−1): with one trade there is no spread to speak of.
  const variance =
    samples > 1
      ? perTradePnl.reduce((a, b) => a + (b - expectancy) ** 2, 0) / (samples - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const stdError = samples > 0 ? stdDev / Math.sqrt(samples) : 0;
  const tStat = stdError > 0 ? expectancy / stdError : 0;

  const margin = 1.96 * stdError;
  const ci95: [number, number] = [expectancy - margin, expectancy + margin];

  const wins = perTradePnl.filter((p) => p > 0);
  const losses = perTradePnl.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const significant = samples >= MIN_SAMPLES && Math.abs(tStat) >= 1.96;

  return {
    samples,
    expectancy,
    stdDev,
    stdError,
    tStat,
    ci95,
    sharpe: stdDev > 0 ? expectancy / stdDev : 0,
    winRate: samples > 0 ? wins.length / samples : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    significant,
    verdict: verdictFor(samples, expectancy, tStat, significant),
  };
}

function verdictFor(samples: number, expectancy: number, tStat: number, significant: boolean): string {
  if (samples < MIN_SAMPLES) {
    return `Only ${samples} closed trade${samples === 1 ? '' : 's'} — too few to distinguish skill from luck (need ~${MIN_SAMPLES}).`;
  }
  if (!significant) {
    return `${samples} trades, but the result is within noise (t=${tStat.toFixed(2)}, needs |t|≥1.96). Not yet distinguishable from zero.`;
  }
  return expectancy > 0
    ? `${samples} trades, mean +$${expectancy.toFixed(4)}/trade, t=${tStat.toFixed(2)} — distinguishable from zero.`
    : `${samples} trades, mean -$${Math.abs(expectancy).toFixed(4)}/trade, t=${tStat.toFixed(2)} — reliably losing.`;
}

/**
 * Per-trade PnL from a trade log.
 *
 * Only closed trades carry realised PnL, so entries contribute nothing —
 * counting them would dilute the sample with guaranteed zeros.
 */
export function perTradePnl(trades: Array<{ realizedPnl: number; side: string }>): number[] {
  return trades.filter((t) => t.side === 'SELL').map((t) => t.realizedPnl);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Drawdown — the number that decides whether a strategy is
   survivable.

   Win rate says how often you are right; drawdown says how much
   it costs to be wrong at the worst possible time. Selling
   longshots wins 19 times in 20 and shows a beautiful win rate
   right up until the 20th trade. Only the equity curve sees it,
   which is why this walks balances in time order rather than
   summarising per-trade PnL.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface DrawdownPoint {
  ts: number;
  drawdown: number;
  drawdownPct: number;
}

export interface Drawdown {
  /** Largest peak-to-trough fall in dollars. */
  maxDrawdown: number;
  /** The same fall as a fraction of the high-water mark it fell from. */
  maxDrawdownPct: number;
  /** Per-trade drawdown series, in time order. */
  timeline: DrawdownPoint[];
}

/**
 * Peak-to-trough drawdown over a trade history.
 *
 * Measured on the realised equity curve — `startingCapital + cumulativePnl` —
 * and deliberately NOT on `balanceAfter`. That field is cash
 * (`availableBalance`), so buying a position drops it by the full cost and
 * registers as a drawdown even though the account holds an asset of equal
 * value. A metric that fires whenever capital is deployed would flag every
 * strategy that puts more than the limit to work.
 *
 * The high-water mark starts at `startingCapital`, so a strategy that is
 * down from day one shows a drawdown immediately rather than only after
 * it sets a new peak.
 *
 * Trades are sorted by timestamp here: callers hand us database rows, and
 * an out-of-order pair silently understates the trough.
 *
 * ponytail: realised only — an open position that is deep underwater shows
 * nothing until it closes, so this understates live drawdown. Feed it
 * mark-to-market equity points if unrealised drawdown needs to be caught
 * while the position is still open.
 */
export function drawdown(
  trades: Array<{ timestamp: number; cumulativePnl: number }>,
  startingCapital: number,
): Drawdown {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  let peak = startingCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  const timeline: DrawdownPoint[] = [];

  for (const t of sorted) {
    const equity = startingCapital + t.cumulativePnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    timeline.push({ ts: t.timestamp, drawdown: dd, drawdownPct: ddPct });
  }

  return { maxDrawdown, maxDrawdownPct, timeline };
}
