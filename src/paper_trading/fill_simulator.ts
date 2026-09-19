import { walkBook, sizeAhead, bestBid, bestAsk, type DepthBook } from '../data/book_feed';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Paper fill model — pure, so it can be tested and argued with.

   The old model filled every order instantly, in full, at the
   order's own limit price.  For a market maker that guarantees
   profit: MM edge IS the question of whether a resting quote is
   hit and whether it is hit only when the market moves against
   you.  This model answers both.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface Book {
  bid: number;
  ask: number;
  /** Market-wide liquidity in USD, from Gamma. */
  liquidity: number;
  /** Real L2 depth when the book feed has it. Best price LAST on both sides. */
  depth?: DepthBook;
}

export interface SimulatedFill {
  filledSize: number;
  /** Price actually paid/received. 0 when nothing filled. */
  fillPrice: number;
  restingSize: number;
}

/**
 * Share depth assumed available at the touch.
 *
 * ponytail: Gamma gives market-wide liquidity, not depth at the touch, so
 * this takes a flat slice of it. Swap for real order book depth (the CLOB
 * /book endpoint) if fill realism starts mattering more than fill direction.
 */
const DEPTH_FRACTION = 0.1;
/** Price impact when an order consumes the whole assumed depth. */
const MAX_IMPACT = 0.02;

export function depthAtTouch(book: Book, price: number): number {
  if (!(price > 0) || !Number.isFinite(book.liquidity) || book.liquidity <= 0) return 0;
  return (book.liquidity * DEPTH_FRACTION) / price;
}

/**
 * Would the venue refuse this order outright?
 *
 * The real CLOB rejects an off-tick price and a sub-minimum size. Paper
 * accepting them means a strategy can look profitable on orders that would
 * never have been accepted.
 */
export function rejectionReason(
  order: { price: number; size: number },
  book: Book | undefined,
): string | undefined {
  const tick = book?.depth?.tickSize;
  if (tick && tick > 0) {
    // Guard against float dust: 0.42 / 0.01 is not exactly 42.
    const steps = order.price / tick;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return `price ${order.price} is not a multiple of tick size ${tick}`;
    }
  }

  const minSize = book?.depth?.minOrderSize;
  if (minSize && order.size < minSize) {
    return `size ${order.size} is below the market minimum of ${minSize}`;
  }

  if (order.price <= 0 || order.price >= 1) {
    return `price ${order.price} is outside (0, 1)`;
  }

  return undefined;
}

/**
 * An order arriving at the book right now.
 *
 * It fills only if it is marketable — a BUY must reach the ask, a SELL must
 * reach the bid.  It fills AT the touch, not at its own limit, because you
 * cross the spread to get filled.  Anything the assumed depth cannot absorb
 * is left resting.
 */
export function simulateMarketable(
  order: { side: 'BUY' | 'SELL'; price: number; size: number },
  book: Book | undefined,
): SimulatedFill {
  // No book: refuse to invent a fill. Understating fills is the safe error.
  if (!book || !Number.isFinite(book.bid) || !Number.isFinite(book.ask)) {
    return { filledSize: 0, fillPrice: 0, restingSize: order.size };
  }

  /* ── Real depth, when we have it ──
     Walk the actual levels our limit accepts and pay the volume-weighted
     price. This replaces the liquidity-slice approximation entirely: it
     models both whether we fill and what a large order costs as it eats
     through the book. */
  if (book.depth) {
    const { filled, vwap } = walkBook(book.depth, order.side, order.price, order.size);
    if (filled <= 0) return { filledSize: 0, fillPrice: 0, restingSize: order.size };
    return {
      filledSize: filled,
      fillPrice: Number(Math.max(0.001, Math.min(0.999, vwap)).toFixed(4)),
      restingSize: Math.max(0, order.size - filled),
    };
  }

  const touch = order.side === 'BUY' ? book.ask : book.bid;
  const marketable = order.side === 'BUY' ? order.price >= book.ask : order.price <= book.bid;
  if (!marketable || !(touch > 0)) {
    return { filledSize: 0, fillPrice: 0, restingSize: order.size };
  }

  const depth = depthAtTouch(book, touch);
  const filledSize = Math.min(order.size, depth);
  if (filledSize <= 0) {
    return { filledSize: 0, fillPrice: 0, restingSize: order.size };
  }

  // Eating more of the book costs more.
  const consumed = depth > 0 ? Math.min(1, filledSize / depth) : 1;
  const impact = MAX_IMPACT * consumed;
  const fillPrice = order.side === 'BUY' ? touch * (1 + impact) : touch * (1 - impact);

  return {
    filledSize,
    fillPrice: Number(Math.max(0.001, Math.min(0.999, fillPrice)).toFixed(4)),
    restingSize: Math.max(0, order.size - filledSize),
  };
}

/**
 * Does a resting order get hit by the current book?
 *
 * A resting BUY fills when the bid falls to it — someone sold into us, which
 * is to say the market moved against us.  That is adverse selection, and
 * modelling it is the whole point: a market maker that only ever fills on
 * favourable moves is not a market maker.
 */
export function restingOrderFills(
  order: { side: 'BUY' | 'SELL'; price: number; size?: number },
  book: Book | undefined,
): boolean {
  if (!book || !Number.isFinite(book.bid) || !Number.isFinite(book.ask)) return false;

  /* ── With real depth we can model the queue ──
     Our paper order is not in the exchange's book, so if size still rests at
     or better than our price, those orders are ahead of us and get hit
     first. We only fill once the market trades strictly THROUGH our price,
     which means the queue ahead was cleared. */
  if (book.depth) {
    const ahead = sizeAhead(book.depth, order.side, order.price);
    const touch = order.side === 'BUY' ? bestBid(book.depth) : bestAsk(book.depth);
    if (touch === undefined) return false;
    if (ahead > 0) {
      return order.side === 'BUY' ? touch < order.price : touch > order.price;
    }
    return order.side === 'BUY' ? touch <= order.price : touch >= order.price;
  }

  return order.side === 'BUY' ? book.bid <= order.price : book.ask >= order.price;
}
