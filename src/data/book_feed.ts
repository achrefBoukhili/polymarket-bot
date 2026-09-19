import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { withRetry } from '../execution/retry';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Real L2 order books, batched.

   Gamma gives one aggregate "liquidity" number per market every
   15s, which is not enough to know whether an order would fill.
   The CLOB /books endpoint returns actual price levels with
   sizes for many tokens in a single POST, so it is cheap to poll
   far more often.

   VERIFIED against the live endpoint: both arrays are ordered so
   that THE BEST PRICE IS LAST — bids ascend (…0.64, 0.65), asks
   descend (0.99, 0.98 … 0.67, 0.66). Reading index 0 gives the
   worst price on both sides.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface Level {
  price: number;
  size: number;
}

export interface DepthBook {
  tokenId: string;
  bids: Level[];
  asks: Level[];
  tickSize?: number;
  minOrderSize?: number;
  updatedAt: number;
}

interface RawBook {
  asset_id: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  tick_size?: string;
  min_order_size?: string;
}

/**
 * Best bid = highest price anyone will pay.
 *
 * Computed, not read positionally. The REST and WS feeds both put the best
 * price LAST, but a max/min never inverts if that ever changes — and reading
 * index 0 would silently return the WORST price on both sides.
 */
export function bestBid(book: DepthBook | undefined): number | undefined {
  if (!book?.bids?.length) return undefined;
  return Math.max(...book.bids.map((l) => l.price));
}

/** Best ask = lowest price anyone will sell at. */
export function bestAsk(book: DepthBook | undefined): number | undefined {
  if (!book?.asks?.length) return undefined;
  return Math.min(...book.asks.map((l) => l.price));
}

/**
 * Walk the opposing side of the book, consuming size at prices our limit
 * accepts, and return the shares filled plus the volume-weighted price.
 *
 * This is the real answer to "would this order fill, and at what price" —
 * as opposed to guessing from an aggregate liquidity figure.
 */
export function walkBook(
  book: DepthBook | undefined,
  side: 'BUY' | 'SELL',
  limitPrice: number,
  size: number,
): { filled: number; vwap: number } {
  const raw = side === 'BUY' ? book?.asks : book?.bids;
  if (!raw?.length || !(size > 0)) return { filled: 0, vwap: 0 };

  // Sort best-first ourselves rather than trusting the feed's ordering.
  const levels = [...raw].sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));

  let remaining = size;
  let notional = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const acceptable = side === 'BUY' ? level.price <= limitPrice : level.price >= limitPrice;
    if (!acceptable) break; // sorted best-first, so everything after is worse

    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
  }

  const filled = size - remaining;
  return { filled, vwap: filled > 0 ? notional / filled : 0 };
}

/**
 * Size resting ahead of a limit order at `price`.
 *
 * Everything at a better price, plus everything already queued at the same
 * price — we join the back of that queue, not the front.
 */
export function sizeAhead(
  book: DepthBook | undefined,
  side: 'BUY' | 'SELL',
  price: number,
): number {
  const levels = side === 'BUY' ? book?.bids : book?.asks;
  if (!levels?.length) return 0;

  return levels.reduce((sum, level) => {
    const better = side === 'BUY' ? level.price > price : level.price < price;
    const same = Math.abs(level.price - price) < 1e-9;
    return better || same ? sum + level.size : sum;
  }, 0);
}

export class BookFeed {
  private readonly books = new Map<string, DepthBook>();
  private readonly tracked = new Set<string>();
  private timer?: NodeJS.Timeout;
  private isPolling = false;

  constructor(
    private readonly clobApi = process.env.POLYMARKET_CLOB_API ?? 'https://clob.polymarket.com',
    private readonly pollMs = Number(process.env.BOOK_POLL_MS ?? 3000),
    /** One POST carries many tokens; this bounds the request size. */
    private readonly maxTokens = Number(process.env.BOOK_MAX_TOKENS ?? 200),
  ) {}

  /** Replace the tracked set — called as strategies change which markets they quote. */
  track(tokenIds: string[]): void {
    this.tracked.clear();
    for (const id of tokenIds.slice(0, this.maxTokens)) this.tracked.add(id);
  }

  getBook(tokenId: string): DepthBook | undefined {
    return this.books.get(tokenId);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    logger.info({ pollMs: this.pollMs }, 'BookFeed started (real L2 depth from /books)');
    consoleLog.success('SCAN', `BookFeed started — real order books every ${this.pollMs / 1000}s`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    logger.info('BookFeed stopped');
  }

  private async poll(): Promise<void> {
    if (this.isPolling || this.tracked.size === 0) return;
    this.isPolling = true;

    try {
      const params = [...this.tracked].map((token_id) => ({ token_id }));
      const raw = await withRetry('books', async () => {
        const response = await fetch(`${this.clobApi}/books`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        if (!response.ok) throw new Error(`/books returned ${response.status}`);
        return (await response.json()) as RawBook[];
      });

      const now = Date.now();
      for (const b of raw) {
        if (!b?.asset_id) continue;
        this.books.set(b.asset_id, {
          tokenId: b.asset_id,
          bids: (b.bids ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) })),
          asks: (b.asks ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) })),
          tickSize: b.tick_size ? Number(b.tick_size) : undefined,
          minOrderSize: b.min_order_size ? Number(b.min_order_size) : undefined,
          updatedAt: now,
        });
      }
    } catch (error) {
      logger.error({ error }, 'BookFeed poll failed — falling back to Gamma prices');
    } finally {
      this.isPolling = false;
    }
  }
}
