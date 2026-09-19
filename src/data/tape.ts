import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { MarketData } from '../types';
import type { DepthBook } from './book_feed';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Tapes: record live market data, replay it deterministically.

   A live-forward paper run sees different markets at different
   times on every run, so two parameter sets can never be
   compared — you are comparing market conditions, not
   strategies. A tape fixes the conditions: same input, same
   output, and a month of history replays in minutes.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export type TapeEvent =
  | { t: number; kind: 'snapshot'; markets: MarketData[] }
  | { t: number; kind: 'book'; book: DepthBook };

/**
 * Appends events as JSON Lines — streamable, greppable, appendable.
 *
 * Writes synchronously. A buffered stream loses whatever is still in the
 * buffer when the process is killed, and losing the tail of a recording is
 * exactly the failure a recorder must not have. Volume is one snapshot per
 * poll, so the cost is irrelevant.
 */
export class TapeRecorder {
  private active = false;
  private count = 0;

  constructor(private readonly file: string) {}

  start(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.active = true;
    logger.info({ file: this.file }, 'Tape recording started');
    consoleLog.success('SCAN', `Recording tape to ${this.file}`);
  }

  write(event: TapeEvent): void {
    if (!this.active) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
      this.count++;
    } catch (err) {
      // Recording must never take the bot down with it.
      logger.error({ file: this.file, err }, 'Tape write failed');
    }
  }

  recordSnapshot(markets: MarketData[]): void {
    this.write({ t: Date.now(), kind: 'snapshot', markets });
  }

  recordBook(book: DepthBook): void {
    this.write({ t: Date.now(), kind: 'book', book });
  }

  stop(): void {
    this.active = false;
    logger.info({ file: this.file, events: this.count }, 'Tape recording stopped');
  }

  getCount(): number {
    return this.count;
  }
}

export function readTape(file: string): TapeEvent[] {
  const raw = fs.readFileSync(file, 'utf8');
  const events: TapeEvent[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TapeEvent);
    } catch {
      // A truncated final line is normal if recording was killed mid-write.
      logger.warn({ file }, 'Skipping unparseable tape line');
    }
  }
  // Recorded in order, but sort defensively so a concatenated tape still works.
  return events.sort((a, b) => a.t - b.t);
}

/**
 * Stands in for OrderbookStream, driven by a tape instead of the network.
 *
 * Same events and the same accessors, so the Engine cannot tell the
 * difference — which is the point: replay exercises the real strategy code,
 * not a parallel simulation of it.
 */
export class ReplayStream extends EventEmitter {
  private readonly cache = new Map<string, MarketData>();
  private readonly books = new Map<string, DepthBook>();
  private cursor = 0;

  constructor(private readonly events: TapeEvent[]) {
    super();
  }

  getMarket(marketId: string): MarketData | undefined {
    return this.cache.get(marketId);
  }

  getAllMarkets(): MarketData[] {
    return [...this.cache.values()];
  }

  getBook(tokenId: string): DepthBook | undefined {
    return this.books.get(tokenId);
  }

  /** Closed markets are not on the tape, so nothing can be settled from it. */
  async fetchMarketsByIds(): Promise<[]> {
    return [];
  }

  getSeenMarkets(): Array<{ marketId: string; firstSeenAt: string; lastSeenAt: string }> {
    return [];
  }

  start(): void {
    /* Replay is driven by step(), not by a timer. */
  }

  stop(): void {
    /* Nothing to tear down. */
  }

  /** Total events on the tape. */
  size(): number {
    return this.events.length;
  }

  /** Simulated clock: the timestamp of the last event applied. */
  now(): number {
    return this.events[Math.max(0, this.cursor - 1)]?.t ?? 0;
  }

  get done(): boolean {
    return this.cursor >= this.events.length;
  }

  /**
   * Apply events up to and including the next snapshot boundary, so each
   * step corresponds to one poll cycle of the original recording.
   */
  step(): boolean {
    if (this.done) return false;

    let sawSnapshot = false;
    while (this.cursor < this.events.length) {
      const event = this.events[this.cursor++];

      if (event.kind === 'book') {
        this.books.set(event.book.tokenId, event.book);
        continue;
      }

      // snapshot: mirror OrderbookStream's swap semantics exactly.
      this.emit('snapshotBegin', event.markets.length);
      this.cache.clear();
      for (const m of event.markets) {
        this.cache.set(m.marketId, m);
        this.emit('update', m);
      }
      sawSnapshot = true;
      break;
    }
    return sawSnapshot || !this.done;
  }
}
