import { describe, it, expect } from 'vitest';
import { makeRng } from '../src/strategies/benchmarks/prng';
import { RandomEntryStrategy } from '../src/strategies/benchmarks/random_entry';
import { AlwaysQuoteStrategy } from '../src/strategies/benchmarks/always_quote';
import { BuyAndHoldStrategy } from '../src/strategies/benchmarks/buy_and_hold';
import { STRATEGY_REGISTRY } from '../src/strategies/registry';
import type { MarketData, WalletState } from '../src/types';

const mkt = (id: string, liquidity = 5000, bid = 0.48): MarketData => ({
  marketId: id, question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [bid + 0.02, 0.5],
  clobTokenIds: [`t-${id}`, `t-${id}-n`], midPrice: bid + 0.02, bid, ask: bid + 0.04, spread: 0.04,
  volume24h: 10_000, liquidity, timestamp: Date.now(),
});

const wallet = (): WalletState => ({
  walletId: 'w', mode: 'PAPER', assignedStrategy: 'bench', capitalAllocated: 10_000,
  availableBalance: 10_000, openPositions: [], realizedPnl: 0,
  riskLimits: { maxPositionSize: 500, maxExposurePerMarket: 2000, maxDailyLoss: 500, maxOpenTrades: 50, maxDrawdown: 0.5 },
});

const feed = (s: { onSnapshotBegin(): void; onMarketUpdate(m: MarketData): void }, markets: MarketData[]) => {
  s.onSnapshotBegin();
  for (const m of markets) s.onMarketUpdate(m);
};

describe('seeded PRNG', () => {
  it('is reproducible for a given seed', () => {
    const a = makeRng(42), b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs between seeds, so a result can be checked against another draw', () => {
    const a = makeRng(1), b = makeRng(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0,1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('all three benchmarks are registered', () => {
  it.each(['benchmark_random', 'benchmark_always_quote', 'benchmark_buy_and_hold'])(
    '%s is usable as a wallet strategy', (key) => {
      expect(STRATEGY_REGISTRY[key]).toBeDefined();
    },
  );
});

describe('RandomEntryStrategy', () => {
  const markets = Array.from({ length: 40 }, (_, i) => mkt(`m${i}`));

  const run = (seed: number) => {
    const s = new RandomEntryStrategy();
    s.initialize({ wallet: wallet(), config: { seed, entryProbability: 0.3 } });
    feed(s, markets);
    return s.generateSignals().map((x) => `${x.marketId}:${x.outcome}`);
  };

  it('produces identical picks for the same seed — replay stays deterministic', () => {
    expect(run(123)).toEqual(run(123));
  });

  it('produces different picks for a different seed', () => {
    expect(run(123)).not.toEqual(run(999));
  });

  it('actually enters, and respects the open-position cap', () => {
    const s = new RandomEntryStrategy();
    s.initialize({ wallet: wallet(), config: { seed: 5, entryProbability: 1, maxOpen: 3 } });
    feed(s, markets);
    expect(s.generateSignals()).toHaveLength(3);
  });

  it('expresses no view — confidence and edge are flat', () => {
    const s = new RandomEntryStrategy();
    s.initialize({ wallet: wallet(), config: { seed: 5, entryProbability: 1 } });
    feed(s, markets);
    for (const sig of s.generateSignals()) {
      expect(sig.edge).toBe(0);
      expect(sig.confidence).toBe(1);
    }
  });
});

describe('AlwaysQuoteStrategy', () => {
  it('quotes the most liquid markets, up to its cap', () => {
    const s = new AlwaysQuoteStrategy();
    s.initialize({ wallet: wallet(), config: { maxMarkets: 3 } });
    feed(s, [mkt('a', 100), mkt('b', 9000), mkt('c', 5000), mkt('d', 7000), mkt('e', 50)]);

    const ids = s.generateSignals().map((x) => x.marketId);
    expect(ids).toEqual(['b', 'd', 'c']); // liquidity order, low-liquidity dropped
  });

  it('bids below mid by the configured half-spread', () => {
    const s = new AlwaysQuoteStrategy();
    s.initialize({ wallet: wallet(), config: { halfSpread: 0.02, quoteSize: 10 } });
    feed(s, [mkt('a', 9000, 0.48)]); // mid = 0.50

    const [order] = s.sizePositions(s.generateSignals());
    expect(order.price).toBeCloseTo(0.48, 4);
    expect(order.size).toBe(10);
  });

  it('declares itself a quoting strategy so the engine cancel-replaces it', () => {
    expect(new AlwaysQuoteStrategy().replacesQuotes).toBe(true);
  });
});

describe('BuyAndHoldStrategy', () => {
  it('buys the liquid markets once and then stops', () => {
    const s = new BuyAndHoldStrategy();
    s.initialize({ wallet: wallet(), config: { maxMarkets: 2 } });
    feed(s, [mkt('a', 9000), mkt('b', 8000), mkt('c', 7000)]);

    const first = s.generateSignals();
    expect(first).toHaveLength(2);
    for (const sig of first) {
      s.notifyFill({ walletId: 'w', marketId: sig.marketId, outcome: 'YES', side: 'BUY', price: 0.5, size: 10, strategy: s.name });
    }

    feed(s, [mkt('a', 9000), mkt('b', 8000), mkt('c', 7000)]);
    expect(s.generateSignals()).toHaveLength(0); // already at its cap, holds
  });

  it('never queues an exit — holding is the whole point', () => {
    const s = new BuyAndHoldStrategy();
    s.initialize({ wallet: wallet(), config: {} });
    feed(s, [mkt('a')]);
    s.notifyFill({ walletId: 'w', marketId: 'a', outcome: 'YES', side: 'BUY', price: 0.5, size: 10, strategy: s.name });

    s.managePositions();
    expect(s.drainExitOrders()).toEqual([]);
  });
});
