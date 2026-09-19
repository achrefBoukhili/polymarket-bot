import { describe, it, expect } from 'vitest';
import { simulateMarketable, restingOrderFills, depthAtTouch } from '../src/paper_trading/fill_simulator';
import { PaperWallet } from '../src/wallets/paper_wallet';
import type { WalletConfig, MarketData } from '../src/types';

const book = { bid: 0.48, ask: 0.52, liquidity: 10_000 };

describe('simulateMarketable', () => {
  it('does NOT fill a bid below the ask — the old model always did', () => {
    const r = simulateMarketable({ side: 'BUY', price: 0.49, size: 10 }, book);
    expect(r.filledSize).toBe(0);
    expect(r.restingSize).toBe(10);
  });

  it('fills a marketable buy at the ask, not at its own limit', () => {
    const r = simulateMarketable({ side: 'BUY', price: 0.60, size: 10 }, book);
    expect(r.filledSize).toBe(10);
    expect(r.fillPrice).toBeGreaterThanOrEqual(0.52); // crossed the spread
    expect(r.fillPrice).toBeLessThan(0.60);
  });

  it('fills a marketable sell at the bid', () => {
    const r = simulateMarketable({ side: 'SELL', price: 0.40, size: 10 }, book);
    expect(r.filledSize).toBe(10);
    expect(r.fillPrice).toBeLessThanOrEqual(0.48);
  });

  it('partially fills when the order is larger than available depth', () => {
    const thin = { bid: 0.48, ask: 0.52, liquidity: 52 }; // ~10 shares at the ask
    const r = simulateMarketable({ side: 'BUY', price: 0.60, size: 100 }, thin);
    expect(r.filledSize).toBeCloseTo(10, 1);
    expect(r.restingSize).toBeCloseTo(90, 1);
  });

  it('charges more impact for consuming more depth', () => {
    const small = simulateMarketable({ side: 'BUY', price: 0.6, size: 1 }, { ...book, liquidity: 1000 });
    const large = simulateMarketable({ side: 'BUY', price: 0.6, size: 190 }, { ...book, liquidity: 1000 });
    expect(large.fillPrice).toBeGreaterThan(small.fillPrice);
  });

  it('invents nothing when there is no book', () => {
    const r = simulateMarketable({ side: 'BUY', price: 0.9, size: 10 }, undefined);
    expect(r.filledSize).toBe(0);
  });

  it('reports zero depth for a market with no liquidity', () => {
    expect(depthAtTouch({ bid: 0.4, ask: 0.5, liquidity: 0 }, 0.5)).toBe(0);
  });
});

describe('restingOrderFills — adverse selection', () => {
  it('fills a resting buy only once the bid falls to it', () => {
    expect(restingOrderFills({ side: 'BUY', price: 0.45 }, { bid: 0.48, ask: 0.52, liquidity: 1 })).toBe(false);
    expect(restingOrderFills({ side: 'BUY', price: 0.45 }, { bid: 0.44, ask: 0.46, liquidity: 1 })).toBe(true);
  });

  it('fills a resting sell only once the ask rises to it', () => {
    expect(restingOrderFills({ side: 'SELL', price: 0.55 }, { bid: 0.48, ask: 0.52, liquidity: 1 })).toBe(false);
    expect(restingOrderFills({ side: 'SELL', price: 0.55 }, { bid: 0.56, ask: 0.58, liquidity: 1 })).toBe(true);
  });
});

/* ── The wallet as the engine drives it ── */

const mkt = (over: Partial<MarketData> = {}): MarketData => ({
  marketId: 'm1', question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5],
  clobTokenIds: ['t1', 't2'], midPrice: 0.5, bid: 0.48, ask: 0.52, spread: 0.04,
  volume24h: 10_000, liquidity: 10_000, timestamp: Date.now(), ...over,
});

function wallet() {
  const w = new PaperWallet({ id: 'p', mode: 'PAPER', strategy: 'market_making', capital: 1000 } as WalletConfig, 'market_making');
  let current = mkt();
  w.setMarketSource((id) => (id === current.marketId ? { bid: current.bid, ask: current.ask, liquidity: current.liquidity } : undefined));
  return { w, move: (m: MarketData) => { current = m; w.onMarketUpdate(m); } };
}

describe('PaperWallet', () => {
  it('leaves a non-marketable quote resting instead of filling it', async () => {
    const { w } = wallet();
    const r = await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.45, size: 10 });

    expect(r.filledSize).toBe(0);
    expect(r.restingSize).toBe(10);
    expect(w.getState().openPositions).toEqual([]);
    expect(w.getTradeHistory()).toEqual([]);
    expect(w.getState().availableBalance).toBeCloseTo(1000 - 0.45 * 10); // collateral reserved
  });

  it('fills that resting quote when the market moves down onto it', async () => {
    const { w, move } = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.45, size: 10 });

    move(mkt({ bid: 0.44, ask: 0.46 })); // market came to us — adverse move

    expect(w.getState().openPositions).toHaveLength(1);
    expect(w.getTradeHistory()).toHaveLength(1);
    expect(w.getState().openPositions[0]).toMatchObject({ size: 10, avgPrice: 0.45 });
    expect(w.getState().availableBalance).toBeCloseTo(1000 - 0.45 * 10);
  });

  it('does not fill a resting quote while the market stays away from it', async () => {
    const { w, move } = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.45, size: 10 });

    move(mkt({ bid: 0.50, ask: 0.54 })); // market ran away

    expect(w.getTradeHistory()).toEqual([]);
  });

  it('releases reserved collateral on cancel', async () => {
    const { w } = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.45, size: 10 });
    await w.cancelAllOrders();

    expect(w.getState().availableBalance).toBe(1000);
    expect(w.getOpenOrders()).toEqual([]);
  });
});
