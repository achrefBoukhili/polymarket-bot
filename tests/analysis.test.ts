import { describe, it, expect } from 'vitest';
import { significance, perTradePnl, drawdown } from '../src/reporting/statistics';
import { sizeThrottle } from '../src/risk/risk_state';
import { AttributionTracker, MARKOUT_HORIZON_MS, type AttributedFill } from '../src/reporting/attribution';

describe('significance', () => {
  it('refuses to call a small sample significant, however good it looks', () => {
    // 20 straight wins — flattering, but not enough trades to distinguish.
    const s = significance(Array(20).fill(2.5));
    expect(s.expectancy).toBeCloseTo(2.5);
    expect(s.significant).toBe(false);
    expect(s.verdict).toMatch(/too few/);
  });

  it('calls a large, consistent edge significant', () => {
    const pnl = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? -1 : 1.5));
    const s = significance(pnl);
    expect(s.expectancy).toBeGreaterThan(0);
    expect(Math.abs(s.tStat)).toBeGreaterThan(1.96);
    expect(s.significant).toBe(true);
  });

  it('refuses a large but noisy sample', () => {
    // Symmetric coin flip: plenty of trades, no edge.
    const pnl = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 10 : -10));
    const s = significance(pnl);
    expect(s.expectancy).toBeCloseTo(0);
    expect(s.significant).toBe(false);
    expect(s.verdict).toMatch(/within noise/);
  });

  it('flags a reliably losing strategy rather than only reporting the loss', () => {
    const s = significance(Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 1 : -1)));
    expect(s.significant).toBe(true);
    expect(s.verdict).toMatch(/reliably losing/);
  });

  it('gives a confidence interval that brackets the mean', () => {
    const s = significance(Array.from({ length: 100 }, (_, i) => i % 7));
    expect(s.ci95[0]).toBeLessThan(s.expectancy);
    expect(s.ci95[1]).toBeGreaterThan(s.expectancy);
  });

  it('handles empty and single-trade inputs without dividing by zero', () => {
    expect(significance([]).verdict).toMatch(/No closed trades/);
    const one = significance([5]);
    expect(one.samples).toBe(1);
    expect(Number.isFinite(one.stdDev)).toBe(true);
    expect(one.significant).toBe(false);
  });

  it('counts only closed trades, so entries do not dilute the sample', () => {
    const pnl = perTradePnl([
      { side: 'BUY', realizedPnl: 0 },
      { side: 'SELL', realizedPnl: 3 },
      { side: 'BUY', realizedPnl: 0 },
      { side: 'SELL', realizedPnl: -1 },
    ]);
    expect(pnl).toEqual([3, -1]);
  });
});

/* ── Attribution ── */

const fill = (o: Partial<AttributedFill> = {}): AttributedFill => ({
  fillId: 'f1', marketId: 'm1', side: 'BUY', price: 0.48, size: 100,
  mid: 0.50, isTaker: false, fee: 0, rebate: 0, timestamp: 1_000, ...o,
});

describe('AttributionTracker', () => {
  it('books buying below mid as captured spread', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ price: 0.48, mid: 0.50, size: 100 }));
    expect(t.snapshot().spreadCapture).toBeCloseTo(2); // 0.02 × 100
  });

  it('books selling above mid as captured spread too', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ side: 'SELL', price: 0.52, mid: 0.50, size: 100 }));
    expect(t.snapshot().spreadCapture).toBeCloseTo(2);
  });

  it('charges adverse selection when the mid moves against us after we fill', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ side: 'BUY', price: 0.48, mid: 0.50, size: 100, timestamp: 0 }));

    // We bought, then the mid dropped — we were picked off.
    t.observeMid('m1', 0.45, MARKOUT_HORIZON_MS + 1);
    expect(t.snapshot().adverseSelection).toBeCloseTo(-5); // -0.05 × 100
  });

  it('credits a favourable move rather than only penalising bad ones', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ side: 'BUY', mid: 0.50, timestamp: 0 }));
    t.observeMid('m1', 0.53, MARKOUT_HORIZON_MS + 1);
    expect(t.snapshot().adverseSelection).toBeCloseTo(3);
  });

  it('does not mark out before the horizon has elapsed', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ timestamp: 0 }));
    t.observeMid('m1', 0.40, MARKOUT_HORIZON_MS - 1);

    const s = t.snapshot();
    expect(s.adverseSelection).toBe(0);
    expect(s.pendingMarkouts).toBe(1);
  });

  it('separates fees, rebates and settlement into their own buckets', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ fee: 1.25, rebate: 0.1875 }));
    t.recordSettlement(7);

    const s = t.snapshot();
    expect(s.fees).toBeCloseTo(1.25);
    expect(s.rebates).toBeCloseTo(0.1875);
    expect(s.settlement).toBeCloseTo(7);
  });

  it('marks open inventory at the latest mid, and skips what it cannot price', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ marketId: 'm1', mid: 0.50 }));
    t.observeMid('m1', 0.55, 0);

    const s = t.snapshot([
      { marketId: 'm1', size: 100, avgPrice: 0.50 },
      { marketId: 'unpriced', size: 999, avgPrice: 0.10 },
    ]);
    expect(s.inventoryCarry).toBeCloseTo(5); // only m1 contributes
  });

  it('totals to the sum of its parts', () => {
    const t = new AttributionTracker();
    t.recordFill(fill({ price: 0.48, mid: 0.50, size: 100, fee: 1, rebate: 0.5, timestamp: 0 }));
    t.observeMid('m1', 0.49, MARKOUT_HORIZON_MS + 1);
    t.recordSettlement(2);

    const s = t.snapshot();
    expect(s.total).toBeCloseTo(
      s.spreadCapture + s.adverseSelection - s.fees + s.rebates + s.inventoryCarry + s.settlement,
    );
  });
});

describe('drawdown', () => {
  // cumulativePnl, i.e. equity = 1000 + cumulativePnl
  const t = (timestamp: number, cumulativePnl: number) => ({ timestamp, cumulativePnl });

  it('measures peak-to-trough, not first-to-last', () => {
    // equity 1000 → 1200 (peak) → 900 (trough) → 1100.
    // End-to-end is +100, but the account was down 300 from its high.
    const d = drawdown([t(1, 0), t(2, 200), t(3, -100), t(4, 100)], 1000);
    expect(d.maxDrawdown).toBe(300);
    expect(d.maxDrawdownPct).toBeCloseTo(300 / 1200);
  });

  it('counts a fall below starting capital before any new peak is set', () => {
    const d = drawdown([t(1, -100), t(2, -50)], 1000);
    expect(d.maxDrawdown).toBe(100);
    expect(d.maxDrawdownPct).toBeCloseTo(0.1);
  });

  it('sorts by timestamp — out-of-order rows would hide the trough', () => {
    const ordered = drawdown([t(1, 0), t(2, -300), t(3, 0)], 1000);
    const shuffled = drawdown([t(3, 0), t(1, 0), t(2, -300)], 1000);
    expect(shuffled.maxDrawdown).toBe(ordered.maxDrawdown);
    expect(shuffled.maxDrawdown).toBe(300);
  });

  it('reports no drawdown for a curve that only rises', () => {
    const d = drawdown([t(1, 100), t(2, 200)], 1000);
    expect(d.maxDrawdown).toBe(0);
    expect(d.maxDrawdownPct).toBe(0);
  });

  it('ignores cash spent opening a position — deploying capital is not a loss', () => {
    // Two entries that spend cash but realise nothing. availableBalance would
    // have fallen by the full cost; realised equity has not moved.
    const d = drawdown([t(1, 0), t(2, 0)], 1000);
    expect(d.maxDrawdown).toBe(0);
    expect(d.maxDrawdownPct).toBe(0);
  });

  it('is empty-safe', () => {
    expect(drawdown([], 1000).maxDrawdownPct).toBe(0);
  });
});

describe('sizeThrottle', () => {
  it('runs full size while the drawdown is shallow', () => {
    expect(sizeThrottle(0, 0.1)).toBe(1);
    expect(sizeThrottle(0.05, 0.1)).toBe(1); // exactly at the ramp start
  });

  it('reaches zero at the limit, so the cliff is never hit at full size', () => {
    expect(sizeThrottle(0.1, 0.1)).toBe(0);
    expect(sizeThrottle(0.5, 0.1)).toBe(0); // past the limit stays zero
  });

  it('ramps monotonically down between half the limit and the limit', () => {
    const points = [0.05, 0.06, 0.07, 0.08, 0.09, 0.1].map((dd) => sizeThrottle(dd, 0.1));
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeLessThan(points[i - 1]);
    }
    expect(sizeThrottle(0.075, 0.1)).toBeCloseTo(0.5); // midpoint of the ramp
  });

  it('never throttles when no limit is configured', () => {
    expect(sizeThrottle(0.9, 0)).toBe(1);
  });
});
