import { describe, it, expect } from 'vitest';
import { tradeFee, scheduleFromBps, type FeeSchedule } from '../src/execution/fees';
import { rebuildPositions, type NormalizedFill } from '../src/wallets/reconciliation';

const sched = (rate: number): FeeSchedule => ({ rate, exponent: 1, takerOnly: true, enabled: true });

describe('tradeFee — fee = C × rate × p × (1−p)', () => {
  // Values taken directly from docs.polymarket.com/trading/fees, 100 shares.
  it.each([
    ['crypto', 0.07, 0.50, 1.75],
    ['crypto', 0.07, 0.30, 1.47],
    ['crypto', 0.07, 0.10, 0.63],
    ['sports', 0.05, 0.50, 1.25],
    ['sports', 0.05, 0.20, 0.80],
    ['politics', 0.04, 0.50, 1.00],
    ['politics', 0.04, 0.25, 0.75],
  ])('%s at rate %s, price %s → $%s', (_c, rate, price, expected) => {
    expect(tradeFee(price, 100, sched(rate), true)).toBeCloseTo(expected, 2);
  });

  it('is symmetric about 50¢', () => {
    expect(tradeFee(0.30, 100, sched(0.07), true)).toBeCloseTo(tradeFee(0.70, 100, sched(0.07), true));
  });

  it('peaks at 50¢ and falls toward both extremes', () => {
    const at = (p: number) => tradeFee(p, 100, sched(0.07), true);
    expect(at(0.5)).toBeGreaterThan(at(0.3));
    expect(at(0.5)).toBeGreaterThan(at(0.7));
    expect(at(0.01)).toBeLessThan(at(0.1));
  });

  it('charges MAKERS nothing — the whole point for a market maker', () => {
    expect(tradeFee(0.5, 100, sched(0.05), false)).toBe(0);
    expect(tradeFee(0.5, 100, sched(0.05), true)).toBeGreaterThan(0);
  });

  it('charges nothing on a fee-free market', () => {
    expect(tradeFee(0.5, 100, { rate: 0.05, enabled: false }, true)).toBe(0);
    expect(tradeFee(0.5, 100, undefined, true)).toBe(0);
  });

  it('returns 0 rather than NaN on nonsense input', () => {
    expect(tradeFee(NaN, 10, sched(0.05), true)).toBe(0);
    expect(tradeFee(0.5, 0, sched(0.05), true)).toBe(0);
    expect(tradeFee(1, 10, sched(0.05), true)).toBe(0);
  });
});

describe('scheduleFromBps', () => {
  it('reproduces the table from the exchange-reported rate', () => {
    expect(tradeFee(0.5, 100, scheduleFromBps(500), true)).toBeCloseTo(1.25, 4);
    expect(tradeFee(0.5, 100, scheduleFromBps(700), true)).toBeCloseTo(1.75, 4);
  });

  it('is undefined for a zero or missing rate', () => {
    expect(scheduleFromBps(0)).toBeUndefined();
    expect(scheduleFromBps(undefined)).toBeUndefined();
  });
});

const fill = (o: Partial<NormalizedFill>): NormalizedFill => ({
  fillId: 'f', tokenId: 'tok1', conditionId: 'c', outcome: 'Yes',
  side: 'BUY', price: 0.5, size: 10, timestamp: 1, feeRateBps: 0, isTaker: true, ...o,
});

describe('fees in reconciled PnL', () => {
  it('charges the entry as well as the exit for a taker', () => {
    const { realizedPnl, grossRealizedPnl, fees } = rebuildPositions([
      fill({ fillId: 'a', side: 'BUY', price: 0.4, size: 100, timestamp: 1, feeRateBps: 500 }),
      fill({ fillId: 'b', side: 'SELL', price: 0.6, size: 100, timestamp: 2, feeRateBps: 500 }),
    ]);
    expect(grossRealizedPnl).toBeCloseTo(20);
    // 100 × 0.05 × (0.4×0.6) + 100 × 0.05 × (0.6×0.4) = 1.20 + 1.20
    expect(fees).toBeCloseTo(2.4, 2);
    expect(realizedPnl).toBeCloseTo(20 - 2.4, 2);
  });

  it('charges a maker-filled round trip nothing', () => {
    const { realizedPnl, grossRealizedPnl, fees } = rebuildPositions([
      fill({ fillId: 'a', side: 'BUY', price: 0.4, size: 100, timestamp: 1, feeRateBps: 0, isTaker: false }),
      fill({ fillId: 'b', side: 'SELL', price: 0.6, size: 100, timestamp: 2, feeRateBps: 0, isTaker: false }),
    ]);
    expect(fees).toBe(0);
    expect(realizedPnl).toBe(grossRealizedPnl);
  });

  it('still charges fees on a position that never closed', () => {
    const { grossRealizedPnl, fees, realizedPnl } = rebuildPositions([
      fill({ fillId: 'a', side: 'BUY', price: 0.4, size: 100, feeRateBps: 500 }),
    ]);
    expect(grossRealizedPnl).toBe(0);
    expect(fees).toBeCloseTo(1.2, 2);
    expect(realizedPnl).toBeCloseTo(-1.2, 2);
  });
});
