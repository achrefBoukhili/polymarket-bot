import { describe, it, expect } from 'vitest';
import { bestBid, bestAsk, walkBook, sizeAhead, type DepthBook } from '../src/data/book_feed';
import { simulateMarketable, restingOrderFills } from '../src/paper_trading/fill_simulator';

/** Ordered as the live API actually returns: best price LAST on both sides. */
const book: DepthBook = {
  tokenId: 't1',
  bids: [ { price: 0.60, size: 500 }, { price: 0.64, size: 200 }, { price: 0.65, size: 100 } ],
  asks: [ { price: 0.70, size: 400 }, { price: 0.67, size: 150 }, { price: 0.66, size: 50 } ],
  updatedAt: Date.now(),
};

describe('book ordering', () => {
  it('reads the best price from the END of each array, not the start', () => {
    expect(bestBid(book)).toBe(0.65); // NOT 0.60
    expect(bestAsk(book)).toBe(0.66); // NOT 0.70
  });

  it('returns nothing for an empty or missing book', () => {
    expect(bestBid(undefined)).toBeUndefined();
    expect(bestAsk({ ...book, asks: [] })).toBeUndefined();
  });
});

describe('walkBook', () => {
  it('fills at the touch when size fits in the best level', () => {
    const { filled, vwap } = walkBook(book, 'BUY', 0.70, 50);
    expect(filled).toBe(50);
    expect(vwap).toBeCloseTo(0.66);
  });

  it('eats through levels and pays a worse average for size', () => {
    const { filled, vwap } = walkBook(book, 'BUY', 0.70, 200);
    expect(filled).toBe(200); // 50@0.66 + 150@0.67
    expect(vwap).toBeCloseTo((50 * 0.66 + 150 * 0.67) / 200);
  });

  it('stops at the limit price instead of paying through it', () => {
    const { filled } = walkBook(book, 'BUY', 0.66, 200);
    expect(filled).toBe(50); // only the 0.66 level is acceptable
  });

  it('fills a sell against the bids, best first', () => {
    const { filled, vwap } = walkBook(book, 'SELL', 0.64, 150);
    expect(filled).toBe(150); // 100@0.65 + 50@0.64
    expect(vwap).toBeCloseTo((100 * 0.65 + 50 * 0.64) / 150);
  });

  it('fills nothing when the limit is unreachable', () => {
    expect(walkBook(book, 'BUY', 0.50, 10).filled).toBe(0);
  });
});

describe('sizeAhead — queue position', () => {
  it('counts better prices and the queue already at our price', () => {
    // A bid at 0.64: 100 sits at 0.65 (better) and 200 at 0.64 (ahead of us).
    expect(sizeAhead(book, 'BUY', 0.64)).toBe(300);
  });

  it('is zero when we would be alone at the front', () => {
    expect(sizeAhead(book, 'BUY', 0.66)).toBe(0); // inside the spread
  });
});

describe('fill model with real depth', () => {
  const withDepth = { bid: 0.65, ask: 0.66, liquidity: 10_000, depth: book };

  it('prices a large marketable order by walking the book', () => {
    const r = simulateMarketable({ side: 'BUY', price: 0.70, size: 200 }, withDepth);
    expect(r.filledSize).toBe(200);
    expect(r.fillPrice).toBeCloseTo(0.6675, 3); // VWAP, worse than the touch
  });

  it('partially fills when the book is thinner than the order', () => {
    const r = simulateMarketable({ side: 'BUY', price: 0.67, size: 1000 }, withDepth);
    expect(r.filledSize).toBe(200); // 50 + 150 available at ≤0.67
    expect(r.restingSize).toBe(800);
  });

  it('does not fill a resting order while a queue sits ahead of it', () => {
    // Our bid at 0.64 with 300 ahead: the market touching 0.64 hits them first.
    expect(restingOrderFills({ side: 'BUY', price: 0.64 }, withDepth)).toBe(false);
  });

  it('fills a resting order once the market trades through it', () => {
    const through: DepthBook = { ...book, bids: [{ price: 0.62, size: 10 }] };
    expect(restingOrderFills({ side: 'BUY', price: 0.64 }, { ...withDepth, depth: through })).toBe(true);
  });
});
