import { describe, it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { TapeRecorder, readTape, ReplayStream, type TapeEvent } from '../src/data/tape';
import type { MarketData } from '../src/types';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-')), 't.jsonl');

const mkt = (id: string, bid = 0.48): MarketData => ({
  marketId: id, question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5],
  clobTokenIds: [`tok-${id}`, `tok-${id}-no`], midPrice: 0.5, bid, ask: bid + 0.04, spread: 0.04,
  volume24h: 1, liquidity: 1000, timestamp: 1,
});

const book = (tokenId: string) => ({
  tokenId, bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.52, size: 100 }], updatedAt: 1,
});

describe('TapeRecorder', () => {
  it('round-trips snapshots and books through the file', () => {
    const f = tmp();
    const r = new TapeRecorder(f);
    r.start();
    r.recordSnapshot([mkt('a'), mkt('b')]);
    r.recordBook(book('tok-a'));
    r.stop();

    const events = readTape(f);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('snapshot');
    expect(events[1].kind).toBe('book');
  });

  it('survives a truncated final line from a killed recorder', () => {
    const f = tmp();
    const r = new TapeRecorder(f);
    r.start();
    r.recordSnapshot([mkt('a')]);
    r.stop();
    fs.appendFileSync(f, '{"t":1,"kind":"snap');  // cut off mid-write

    expect(readTape(f)).toHaveLength(1); // the good line still loads
  });

  it('orders events by time even if the file is concatenated out of order', () => {
    const f = tmp();
    fs.writeFileSync(f, [
      JSON.stringify({ t: 200, kind: 'snapshot', markets: [mkt('late')] }),
      JSON.stringify({ t: 100, kind: 'snapshot', markets: [mkt('early')] }),
    ].join('\n'));

    expect(readTape(f).map((e) => e.t)).toEqual([100, 200]);
  });
});

describe('ReplayStream', () => {
  const tape: TapeEvent[] = [
    { t: 1, kind: 'book', book: book('tok-a') },
    { t: 2, kind: 'snapshot', markets: [mkt('a'), mkt('b')] },
    { t: 3, kind: 'snapshot', markets: [mkt('a', 0.60)] },  // 'b' closed
  ];

  it('emits snapshotBegin before the updates, like the live stream', () => {
    const s = new ReplayStream(tape);
    const order: string[] = [];
    s.on('snapshotBegin', () => order.push('begin'));
    s.on('update', (m: MarketData) => order.push(`update:${m.marketId}`));

    s.step();
    expect(order).toEqual(['begin', 'update:a', 'update:b']);
  });

  it('swaps the cache each snapshot, dropping markets that vanish', () => {
    const s = new ReplayStream(tape);
    s.step();
    expect(s.getAllMarkets().map((m) => m.marketId)).toEqual(['a', 'b']);
    s.step();
    expect(s.getAllMarkets().map((m) => m.marketId)).toEqual(['a']);
  });

  it('serves recorded books', () => {
    const s = new ReplayStream(tape);
    s.step();
    expect(s.getBook('tok-a')?.bids[0].size).toBe(100);
  });

  it('runs to completion and then reports done', () => {
    const s = new ReplayStream(tape);
    let steps = 0;
    while (s.step()) steps++;
    expect(steps).toBe(2);       // two snapshot cycles
    expect(s.done).toBe(true);
  });

  it('is deterministic — the same tape yields the same sequence every time', () => {
    const run = () => {
      const s = new ReplayStream(tape);
      const seen: string[] = [];
      s.on('update', (m: MarketData) => seen.push(`${m.marketId}@${m.bid}`));
      while (s.step());
      return seen;
    };
    expect(run()).toEqual(run());
  });

  it('reports an empty tape as immediately done rather than hanging', () => {
    const s = new ReplayStream([]);
    expect(s.step()).toBe(false);
    expect(s.done).toBe(true);
  });
});
