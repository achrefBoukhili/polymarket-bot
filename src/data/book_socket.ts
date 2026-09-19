import { EventEmitter } from 'events';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import type { DepthBook, Level } from './book_feed';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Polymarket market WebSocket.

   Wire format per docs.polymarket.com/market-data/realtime-data
   (the raw "API" tab, not the SDK wrapper — the raw frames are
   flat snake_case, the SDK nests them under `payload`):

     url        wss://ws-subscriptions-clob.polymarket.com/ws/market
     subscribe  {"assets_ids":["<token>"],"type":"market"}
     heartbeat  send the text frame `PING` every 10s → server PONGs
     events     book | price_change | last_trade_price | tick_size_change

   This replaces 3s REST polling of /books. The REST feed stays as
   the fallback: if the socket cannot connect or goes quiet, books
   keep updating rather than freezing at their last value.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const WS_URL =
  process.env.POLYMARKET_WS_URL ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_MS = 10_000;
/** Treat the socket as dead if nothing arrives for this long. */
const STALE_AFTER_MS = 45_000;

interface RawLevel {
  price: string;
  size: string;
}

interface BookEvent {
  event_type: 'book';
  asset_id: string;
  bids?: RawLevel[];
  asks?: RawLevel[];
  timestamp?: string;
  min_order_size?: string;
  tick_size?: string;
}

interface PriceChangeEvent {
  event_type: 'price_change';
  price_changes?: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: string;
    best_bid?: string;
    best_ask?: string;
  }>;
}

interface TickSizeChangeEvent {
  event_type: 'tick_size_change';
  asset_id: string;
  new_tick_size?: string;
}

type MarketEvent = BookEvent | PriceChangeEvent | TickSizeChangeEvent | { event_type?: string };

function toLevels(raw: RawLevel[] | undefined): Level[] {
  return (raw ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
}

export class BookSocket extends EventEmitter {
  private socket?: WebSocket;
  private readonly books = new Map<string, DepthBook>();
  private tokens: string[] = [];
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private lastMessageAt = 0;
  private closed = false;

  getBook(tokenId: string): DepthBook | undefined {
    return this.books.get(tokenId);
  }

  /** True when the socket is connected and has produced data recently. */
  isHealthy(): boolean {
    return (
      this.socket?.readyState === WebSocket.OPEN &&
      this.lastMessageAt > 0 &&
      Date.now() - this.lastMessageAt < STALE_AFTER_MS
    );
  }

  /** Subscribe to a token set. Resubscribing reconnects with the new set. */
  subscribe(tokenIds: string[]): void {
    const next = [...new Set(tokenIds)].filter(Boolean);
    const unchanged =
      next.length === this.tokens.length && next.every((t, i) => t === this.tokens[i]);
    if (unchanged) return;

    this.tokens = next;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ assets_ids: this.tokens, type: 'market' });
    } else {
      this.connect();
    }
  }

  connect(): void {
    if (this.closed || this.tokens.length === 0) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    try {
      const socket = new WebSocket(WS_URL);
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectAttempt = 0;
        this.lastMessageAt = Date.now();
        this.send({ assets_ids: this.tokens, type: 'market' });
        // Application-level heartbeat: the docs require a PING text frame.
        this.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('PING');
        }, HEARTBEAT_MS);
        logger.info({ tokens: this.tokens.length }, 'Market WebSocket connected');
        consoleLog.success('SCAN', `Market WebSocket connected — ${this.tokens.length} tokens`);
      };

      socket.onmessage = (event) => {
        this.lastMessageAt = Date.now();
        const data = typeof event.data === 'string' ? event.data : '';
        if (!data || data === 'PONG' || data === 'PING') return;
        this.handleMessage(data);
      };

      socket.onerror = () => {
        // onclose follows and owns the reconnect.
        logger.warn('Market WebSocket error');
      };

      socket.onclose = () => {
        this.teardownHeartbeat();
        if (this.closed) return;
        const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++);
        logger.warn({ delay, attempt: this.reconnectAttempt }, 'Market WebSocket closed — reconnecting');
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      };
    } catch (err) {
      logger.error({ err }, 'Market WebSocket could not be created — REST book polling continues');
    }
  }

  close(): void {
    this.closed = true;
    this.teardownHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = undefined;
  }

  private teardownHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private send(payload: unknown): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn({ err }, 'Market WebSocket send failed');
    }
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // non-JSON frame (heartbeat echo, etc.)
    }
    // The server may batch events into an array.
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      this.applyEvent(event as MarketEvent);
    }
  }

  private applyEvent(event: MarketEvent): void {
    switch (event.event_type) {
      case 'book': {
        const e = event as BookEvent;
        if (!e.asset_id) return;
        this.books.set(e.asset_id, {
          tokenId: e.asset_id,
          bids: toLevels(e.bids),
          asks: toLevels(e.asks),
          tickSize: e.tick_size ? Number(e.tick_size) : undefined,
          minOrderSize: e.min_order_size ? Number(e.min_order_size) : undefined,
          updatedAt: Date.now(),
        });
        this.emit('book', e.asset_id);
        return;
      }

      case 'price_change': {
        // A delta per level: size 0 removes it, anything else replaces it.
        for (const change of (event as PriceChangeEvent).price_changes ?? []) {
          const book = this.books.get(change.asset_id);
          if (!book) continue; // wait for the snapshot before applying deltas

          const side = String(change.side).toUpperCase() === 'SELL' ? 'asks' : 'bids';
          const price = Number(change.price);
          const size = Number(change.size);
          if (!Number.isFinite(price) || !Number.isFinite(size)) continue;

          const levels = book[side].filter((l) => Math.abs(l.price - price) > 1e-9);
          if (size > 0) levels.push({ price, size });
          // Keep the API's own ordering: ascending for bids, descending for asks.
          levels.sort((a, b) => (side === 'bids' ? a.price - b.price : b.price - a.price));
          book[side] = levels;
          book.updatedAt = Date.now();
          this.emit('book', change.asset_id);
        }
        return;
      }

      case 'tick_size_change': {
        const e = event as TickSizeChangeEvent;
        const book = this.books.get(e.asset_id);
        if (book && e.new_tick_size) book.tickSize = Number(e.new_tick_size);
        return;
      }

      default:
        return; // last_trade_price and anything new: nothing to apply here
    }
  }
}
