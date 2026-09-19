import { describe, it, expect } from 'vitest';
import { OrderbookStream } from '../src/data/orderbook_stream';
import { BaseStrategy } from '../src/strategies/strategy_interface';
import type { MarketData, Signal } from '../src/types';

const mkt = (id: string): MarketData => ({
  marketId: id, question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5],
  clobTokenIds: ['t1', 't2'], midPrice: 0.5, bid: 0.48, ask: 0.52, spread: 0.04,
  volume24h: 1, liquidity: 1, timestamp: Date.now(),
});

class Probe extends BaseStrategy {
  readonly name = 'probe';
  generateSignals(): Signal[] { return []; }
  seen(): string[] { return [...this.markets.keys()]; }
}

describe('snapshot cache hygiene', () => {
  it('drops markets that vanish from the next snapshot', () => {
    const s = new Probe();
    s.onMarketUpdate(mkt('a'));
    s.onMarketUpdate(mkt('b'));
    expect(s.seen()).toEqual(['a', 'b']);

    // New poll cycle: only 'a' is still live.
    s.onSnapshotBegin();
    s.onMarketUpdate(mkt('a'));
    expect(s.seen()).toEqual(['a']); // 'b' is gone, not quoted forever
  });

  it('emits snapshotBegin before the updates, and swaps the cache', async () => {
    const stream = new OrderbookStream(undefined, 60_000, `${process.env.TMPDIR ?? '/tmp'}/seen-${Date.now()}.json`);
    let snapshot: MarketData[] = [mkt('a'), mkt('b')];
    (stream as unknown as { fetcher: { fetchSnapshot(): Promise<MarketData[]> } }).fetcher = {
      fetchSnapshot: async () => snapshot,
    };

    const order: string[] = [];
    stream.on('snapshotBegin', () => order.push('begin'));
    stream.on('update', (m: MarketData) => order.push(`update:${m.marketId}`));

    await (stream as unknown as { poll(): Promise<void> }).poll();
    expect(order).toEqual(['begin', 'update:a', 'update:b']);
    expect(stream.getAllMarkets().map((m) => m.marketId)).toEqual(['a', 'b']);

    snapshot = [mkt('a')]; // 'b' closed
    await (stream as unknown as { poll(): Promise<void> }).poll();
    expect(stream.getAllMarkets().map((m) => m.marketId)).toEqual(['a']);
  });

  it('will not run two polls at once', async () => {
    const stream = new OrderbookStream(undefined, 60_000, `${process.env.TMPDIR ?? '/tmp'}/seen2-${Date.now()}.json`);
    let inFlight = 0;
    let maxConcurrent = 0;
    (stream as unknown as { fetcher: unknown }).fetcher = {
      fetchSnapshot: async () => {
        maxConcurrent = Math.max(maxConcurrent, ++inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return [mkt('a')];
      },
    };

    const poll = () => (stream as unknown as { poll(): Promise<void> }).poll();
    await Promise.all([poll(), poll(), poll()]);
    expect(maxConcurrent).toBe(1);
  });
});
