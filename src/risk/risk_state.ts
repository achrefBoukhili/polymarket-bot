import fs from 'fs';
import path from 'path';
import { Position } from '../types';
import { logger } from '../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Risk state that must outlive the process.
   ─────────────────────────────────────────────────────────────
   A daily loss limit whose anchor resets on restart is not a
   limit — a crash loop clears it every time.  Same for a
   high-water mark: lose it and drawdown reads zero again.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface WalletRiskState {
  /** UTC day this anchor belongs to, YYYY-MM-DD. */
  dayKey: string;
  /** Lifetime realised PnL as of the start of that UTC day. */
  dayStartRealizedPnl: number;
  /** Highest equity ever observed, for peak-to-trough drawdown. */
  peakEquity: number;
}

export function utcDayKey(timestamp: number = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function newRiskState(realizedPnl: number, equity: number, now = Date.now()): WalletRiskState {
  return { dayKey: utcDayKey(now), dayStartRealizedPnl: realizedPnl, peakEquity: equity };
}

/** Re-anchor when the UTC day has turned over. Pure. */
export function rollDay(
  state: WalletRiskState,
  realizedPnl: number,
  now = Date.now(),
): WalletRiskState {
  const today = utcDayKey(now);
  if (state.dayKey === today) return state;
  return { ...state, dayKey: today, dayStartRealizedPnl: realizedPnl };
}

/** PnL since the start of the current UTC day. */
export function dailyPnl(state: WalletRiskState, realizedPnl: number): number {
  return realizedPnl - state.dayStartRealizedPnl;
}

/**
 * Mark open positions to market.
 *
 * Positions whose mark we cannot resolve (reconciled from a market we have
 * not quoted this session) are reported separately rather than silently
 * valued at cost — a risk check that quietly ignores positions is worse
 * than one that says it is blind.
 */
export function markToMarket(
  positions: Position[],
  markPrice: (marketId: string, outcome: 'YES' | 'NO') => number | undefined,
): { unrealizedPnl: number; markedValue: number; unpriced: number } {
  let unrealizedPnl = 0;
  let markedValue = 0;
  let unpriced = 0;

  for (const p of positions) {
    const mark = markPrice(p.marketId, p.outcome);
    if (mark === undefined || !Number.isFinite(mark)) {
      unpriced++;
      markedValue += p.avgPrice * p.size; // fall back to cost, and say so
      continue;
    }
    unrealizedPnl += (mark - p.avgPrice) * p.size;
    markedValue += mark * p.size;
  }

  return { unrealizedPnl, markedValue, unpriced };
}

/** Peak-to-trough drawdown as a fraction of the high-water mark. */
export function drawdownPct(peakEquity: number, equity: number): number {
  if (!(peakEquity > 0)) return 0;
  return Math.max(0, (peakEquity - equity) / peakEquity);
}

/**
 * How much of normal size to risk, given how deep the drawdown already is.
 *
 * The kill switch is a cliff: full size right up to the limit, then nothing.
 * That makes the limit itself the thing you breach — the last trade before
 * the switch trips is the same size as the first, so the account overshoots
 * straight through the ceiling it was supposed to respect.
 *
 * This ramps instead. Full size while the drawdown is shallow, then linearly
 * down to zero at the limit, so losses get progressively cheaper and the
 * ceiling is approached asymptotically rather than crashed through. The kill
 * switch becomes the backstop it should have been.
 *
 * ponytail: linear ramp from half the limit. Upgrade to vol-targeting if
 * sizing needs to react to realised volatility and not just drawdown depth.
 */
export function sizeThrottle(currentDrawdownPct: number, limitPct: number): number {
  if (!(limitPct > 0)) return 1;
  const dd = Math.max(0, currentDrawdownPct);
  const rampStart = limitPct / 2;
  if (dd <= rampStart) return 1;
  if (dd >= limitPct) return 0;
  return (limitPct - dd) / (limitPct - rampStart);
}

/* ── Persistence ── */

export class RiskStateStore {
  private readonly file: string;
  private cache: Record<string, WalletRiskState> = {};

  constructor(file = path.resolve('.runtime/risk_state.json')) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, WalletRiskState>;
    } catch (err) {
      // A corrupt file must not silently reset every limit.
      logger.error({ file: this.file, err }, 'Risk state unreadable — limits restart from zero');
      this.cache = {};
    }
  }

  get(walletId: string): WalletRiskState | undefined {
    return this.cache[walletId];
  }

  set(walletId: string, state: WalletRiskState): void {
    const previous = this.cache[walletId];
    if (
      previous &&
      previous.dayKey === state.dayKey &&
      previous.dayStartRealizedPnl === state.dayStartRealizedPnl &&
      previous.peakEquity === state.peakEquity
    ) {
      return; // nothing changed — skip the write
    }
    this.cache[walletId] = state;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      logger.error({ file: this.file, err }, 'Failed to persist risk state');
    }
  }
}
