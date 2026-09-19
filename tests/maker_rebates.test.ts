import { describe, it, expect } from 'vitest';
import { makerRebate, tradeFee, REBATE_MIN_PAYOUT_USD, type FeeSchedule } from '../src/execution/fees';
import { PaperWallet } from '../src/wallets/paper_wallet';
import type { WalletConfig, MarketData } from '../src/types';

const sports: FeeSchedule = { rate: 0.05, exponent: 1, takerOnly: true, enabled: true, rebateRate: 0.15 };
const politics: FeeSchedule = { rate: 0.04, exponent: 1, takerOnly: true, enabled: true, rebateRate: 0.25 };
const geo: FeeSchedule = { rate: 0, enabled: false, rebateRate: 0 };

describe('makerRebate', () => {
  it('pays the maker a share of the fee its liquidity generated', () => {
    // 100 shares at 50¢ on sports: fee equivalent $1.25, rebate 15% → $0.1875
    expect(makerRebate(0.5, 100, sports, false)).toBeCloseTo(1.25 * 0.15, 6);
  });

  it('uses the same curve as the fee, so it is symmetric about 50¢', () => {
    expect(makerRebate(0.3, 100, sports, false)).toBeCloseTo(makerRebate(0.7, 100, sports, false), 9);
  });

  it('equals the taker fee times the rebate rate — the pool share cancels', () => {
    for (const p of [0.1, 0.25, 0.5, 0.8]) {
      expect(makerRebate(p, 250, politics, false))
        .toBeCloseTo(tradeFee(p, 250, politics, true) * 0.25, 9);
    }
  });

  it('pays TAKERS nothing — the rebate is for providing liquidity', () => {
    expect(makerRebate(0.5, 100, sports, true)).toBe(0);
  });

  it('pays nothing on a fee-free market, since there is no pool', () => {
    expect(makerRebate(0.5, 100, geo, false)).toBe(0);
  });

  it('pays nothing when the schedule carries no rebate rate', () => {
    expect(makerRebate(0.5, 100, { rate: 0.05, enabled: true }, false)).toBe(0);
  });

  it('applies the category rate: politics rebates more than sports', () => {
    const s = makerRebate(0.5, 100, sports, false);
    const p = makerRebate(0.5, 100, politics, false);
    expect(p / tradeFee(0.5, 100, politics, true)).toBeCloseTo(0.25, 6);
    expect(s / tradeFee(0.5, 100, sports, true)).toBeCloseTo(0.15, 6);
  });
});

/* ── Accrual and daily payout ── */

const mkt = (over: Partial<MarketData> = {}): MarketData => ({
  marketId: 'm1', question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5],
  clobTokenIds: ['t1', 't2'], midPrice: 0.5, bid: 0.48, ask: 0.52, spread: 0.04,
  volume24h: 1, liquidity: 100_000, timestamp: Date.now(), ...over,
});

function wallet() {
  const w = new PaperWallet({ id: 'p', mode: 'PAPER', strategy: 'mm', capital: 10_000 } as WalletConfig, 'mm');
  w.setMarketSource(() => ({ bid: 0.48, ask: 0.52, liquidity: 100_000 }));
  w.setFeeSource(() => sports);
  return w;
}

/** Fill a resting bid by walking the market down onto it — a MAKER fill. */
async function makerFill(w: PaperWallet, price: number, size: number) {
  await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price, size });
  w.onMarketUpdate(mkt({ bid: price - 0.01, ask: price + 0.01 }));
}

describe('PaperWallet maker rebates', () => {
  it('accrues on a maker fill but does not credit it immediately', async () => {
    const w = wallet();
    const before = w.getState().availableBalance;

    await makerFill(w, 0.45, 1000);

    expect(w.getRebateAccrued()).toBeCloseTo(makerRebate(0.45, 1000, sports, false), 6);
    expect(w.getRebatesPaid()).toBe(0);
    // Balance reflects the purchase only — rebates settle daily.
    expect(w.getState().availableBalance).toBeCloseTo(before - 0.45 * 1000, 6);
  });

  it('accrues nothing when we were the taker', async () => {
    const w = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 1000 });
    expect(w.getRebateAccrued()).toBe(0);
  });

  it('pays out once the UTC day rolls over', async () => {
    const w = wallet();
    await makerFill(w, 0.45, 2000); // well over the $1 minimum

    const accrued = w.getRebateAccrued();
    expect(accrued).toBeGreaterThan(REBATE_MIN_PAYOUT_USD);
    const balanceBefore = w.getState().availableBalance;

    // Force the day boundary the way the clock would.
    (w as unknown as { rebateDay: string }).rebateDay = ' 1970-01-01';
    await makerFill(w, 0.44, 1); // any fill triggers the due check

    expect(w.getRebatesPaid()).toBeGreaterThanOrEqual(accrued);
    expect(w.getState().availableBalance).toBeGreaterThan(balanceBefore - 0.44);
    expect(w.getRebateAccrued()).toBeLessThan(REBATE_MIN_PAYOUT_USD);
  });

  it('carries a sub-$1 balance forward rather than discarding it', async () => {
    const w = wallet();
    await makerFill(w, 0.45, 5); // tiny — nowhere near $1

    const accrued = w.getRebateAccrued();
    expect(accrued).toBeGreaterThan(0);
    expect(accrued).toBeLessThan(REBATE_MIN_PAYOUT_USD);

    (w as unknown as { rebateDay: string }).rebateDay = '1970-01-01';
    await makerFill(w, 0.44, 5);

    expect(w.getRebatesPaid()).toBe(0);              // nothing paid
    expect(w.getRebateAccrued()).toBeGreaterThan(accrued); // but still growing
  });
});
