import { describe, it, expect } from 'vitest';
import { BookSocket } from '../src/data/book_socket';
import { bestBid, bestAsk } from '../src/data/book_feed';

/** Drive the private frame handler exactly as onmessage would. */
const feed = (s: BookSocket, frame: unknown) =>
  (s as unknown as { handleMessage(d: string): void }).handleMessage(JSON.stringify(frame));

const TOKEN = '107505882767731489358349912513945399560393482969656700824895970500493757150417';

/** Verbatim from docs.polymarket.com/market-data/realtime-data (API tab). */
const BOOK_FRAME = {
  event_type: 'book',
  market: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
  asset_id: TOKEN,
  timestamp: '1782753357257',
  hash: '0xabc123',
  bids: [ { price: '0.08', size: '33343.4' }, { price: '0.09', size: '163939.58' } ],
  asks: [ { price: '0.99', size: '218442.27' }, { price: '0.98', size: '13229.55' } ],
};

describe('BookSocket frame handling', () => {
  it('builds a book from the documented snapshot frame', () => {
    const s = new BookSocket();
    feed(s, BOOK_FRAME);

    const book = s.getBook(TOKEN)!;
    expect(book.bids).toHaveLength(2);
    expect(book.asks).toHaveLength(2);
    // Best bid is the HIGHEST bid and best ask the LOWEST, whatever the order.
    expect(bestBid(book)).toBe(0.09);
    expect(bestAsk(book)).toBe(0.98);
  });

  it('applies a price_change delta to an existing level', () => {
    const s = new BookSocket();
    feed(s, BOOK_FRAME);
    feed(s, {
      event_type: 'price_change',
      price_changes: [{ asset_id: TOKEN, price: '0.09', size: '500', side: 'BUY' }],
      timestamp: '1782753357300',
    });

    const level = s.getBook(TOKEN)!.bids.find((l) => l.price === 0.09);
    expect(level?.size).toBe(500); // replaced, not added to
  });

  it('removes a level when the delta reports size 0', () => {
    const s = new BookSocket();
    feed(s, BOOK_FRAME);
    feed(s, {
      event_type: 'price_change',
      price_changes: [{ asset_id: TOKEN, price: '0.09', size: '0', side: 'BUY' }],
    });

    const book = s.getBook(TOKEN)!;
    expect(book.bids.find((l) => l.price === 0.09)).toBeUndefined();
    expect(bestBid(book)).toBe(0.08); // best bid steps down
  });

  it('adds a new level on the correct side', () => {
    const s = new BookSocket();
    feed(s, BOOK_FRAME);
    feed(s, {
      event_type: 'price_change',
      price_changes: [{ asset_id: TOKEN, price: '0.95', size: '100', side: 'SELL' }],
    });
    expect(bestAsk(s.getBook(TOKEN)!)).toBe(0.95);
  });

  it('ignores deltas for a token it has no snapshot for', () => {
    const s = new BookSocket();
    feed(s, {
      event_type: 'price_change',
      price_changes: [{ asset_id: 'unknown', price: '0.5', size: '10', side: 'BUY' }],
    });
    expect(s.getBook('unknown')).toBeUndefined();
  });

  it('applies tick_size_change', () => {
    const s = new BookSocket();
    feed(s, BOOK_FRAME);
    feed(s, { event_type: 'tick_size_change', asset_id: TOKEN, new_tick_size: '0.001' });
    expect(s.getBook(TOKEN)!.tickSize).toBe(0.001);
  });

  it('survives batched frames, unknown events and junk', () => {
    const s = new BookSocket();
    feed(s, [BOOK_FRAME, { event_type: 'last_trade_price', asset_id: TOKEN, price: '0.5' }]);
    expect(s.getBook(TOKEN)).toBeDefined();

    expect(() =>
      (s as unknown as { handleMessage(d: string): void }).handleMessage('PONG'),
    ).not.toThrow();
  });

  it('is not healthy before it has received anything', () => {
    expect(new BookSocket().isHealthy()).toBe(false);
  });
});
