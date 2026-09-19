import { Database as Sqlite } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import { WalletState, TradeRecord, Position } from '../types';
import { logger } from '../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Durable wallet state.

   LIVE wallets rebuild positions and cash from the exchange, so
   this is belt-and-braces for them.  For PAPER wallets it is the
   only memory there is — without it a restart discards the whole
   experiment, which is what makes paper results worth reading.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class Database {
  private db?: Sqlite;
  private readonly file: string;

  constructor(file = path.resolve('.runtime/wallets.db')) {
    this.file = file;
  }

  async connect(): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Sqlite(this.file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_state (
        wallet_id      TEXT PRIMARY KEY,
        mode           TEXT NOT NULL,
        strategy       TEXT NOT NULL,
        capital        REAL NOT NULL,
        available      REAL NOT NULL,
        realized_pnl   REAL NOT NULL,
        positions      TEXT NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        order_id       TEXT PRIMARY KEY,
        wallet_id      TEXT NOT NULL,
        market_id      TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        side           TEXT NOT NULL,
        price          REAL NOT NULL,
        size           REAL NOT NULL,
        cost           REAL NOT NULL,
        realized_pnl   REAL NOT NULL,
        cumulative_pnl REAL NOT NULL,
        balance_after  REAL NOT NULL,
        timestamp      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet_id, timestamp);
    `);
    logger.info({ file: this.file }, 'Wallet database ready');
  }

  /** Persist a wallet snapshot plus any trades not already stored. */
  saveWallet(state: WalletState, trades: TradeRecord[]): void {
    if (!this.db) return;
    try {
      this.db
        .query(
          `INSERT INTO wallet_state (wallet_id, mode, strategy, capital, available, realized_pnl, positions, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(wallet_id) DO UPDATE SET
             mode=excluded.mode, strategy=excluded.strategy, capital=excluded.capital,
             available=excluded.available, realized_pnl=excluded.realized_pnl,
             positions=excluded.positions, updated_at=excluded.updated_at`,
        )
        .run(
          state.walletId,
          state.mode,
          state.assignedStrategy,
          state.capitalAllocated,
          state.availableBalance,
          state.realizedPnl,
          JSON.stringify(state.openPositions),
          Date.now(),
        );

      // Trade ids are stable, so re-saving the same history is a no-op.
      const insert = this.db.query(
        `INSERT OR IGNORE INTO trades
         (order_id, wallet_id, market_id, outcome, side, price, size, cost, realized_pnl, cumulative_pnl, balance_after, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of trades) {
        insert.run(
          t.orderId, t.walletId, t.marketId, t.outcome, t.side,
          t.price, t.size, t.cost, t.realizedPnl, t.cumulativePnl, t.balanceAfter, t.timestamp,
        );
      }
    } catch (err) {
      logger.error({ walletId: state.walletId, err }, 'Failed to persist wallet');
    }
  }

  loadWallet(walletId: string): { state: Partial<WalletState>; trades: TradeRecord[] } | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .query(`SELECT * FROM wallet_state WHERE wallet_id = ?`)
        .get(walletId) as Record<string, unknown> | null;
      if (!row) return undefined;

      const trades = this.db
        .query(`SELECT * FROM trades WHERE wallet_id = ? ORDER BY timestamp`)
        .all(walletId) as Record<string, unknown>[];

      return {
        state: {
          availableBalance: row.available as number,
          realizedPnl: row.realized_pnl as number,
          openPositions: JSON.parse(row.positions as string) as Position[],
        },
        trades: trades.map((t) => ({
          orderId: t.order_id as string,
          walletId: t.wallet_id as string,
          marketId: t.market_id as string,
          outcome: t.outcome as TradeRecord['outcome'],
          side: t.side as TradeRecord['side'],
          price: t.price as number,
          size: t.size as number,
          cost: t.cost as number,
          realizedPnl: t.realized_pnl as number,
          cumulativePnl: t.cumulative_pnl as number,
          balanceAfter: t.balance_after as number,
          timestamp: t.timestamp as number,
        })),
      };
    } catch (err) {
      logger.error({ walletId, err }, 'Failed to load wallet');
      return undefined;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
