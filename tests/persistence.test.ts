import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../src/storage/database';
import { PaperWallet } from '../src/wallets/paper_wallet';
import type { WalletConfig, MarketData } from '../src/types';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'w.db');

const mkt: MarketData = {
  marketId: 'm1', question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5],
  clobTokenIds: ['t1', 't2'], midPrice: 0.5, bid: 0.48, ask: 0.52, spread: 0.04,
  volume24h: 10_000, liquidity: 10_000, timestamp: Date.now(),
};

function paper() {
  const w = new PaperWallet({ id: 'p', mode: 'PAPER', strategy: 'market_making', capital: 1000 } as WalletConfig, 'market_making');
  w.setMarketSource(() => ({ bid: mkt.bid, ask: mkt.ask, liquidity: mkt.liquidity }));
  return w;
}

describe('wallet persistence', () => {
  it('survives a restart with positions, PnL and trades intact', async () => {
    const file = tmpDb();
    const db = new Database(file);
    await db.connect();

    const w = paper();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 10 }); // marketable
    expect(w.getTradeHistory()).toHaveLength(1);

    db.saveWallet(w.getState(), w.getTradeHistory());
    db.close();

    // Fresh process.
    const db2 = new Database(file);
    await db2.connect();
    const saved = db2.loadWallet('p');
    expect(saved).toBeDefined();

    const restored = paper();
    restored.restore(saved!.state, saved!.trades);

    expect(restored.getState().openPositions).toEqual(w.getState().openPositions);
    expect(restored.getState().realizedPnl).toBe(w.getState().realizedPnl);
    expect(restored.getState().availableBalance).toBe(w.getState().availableBalance);
    expect(restored.getTradeHistory()).toHaveLength(1);
    db2.close();
  });

  it('does not duplicate trades when the same history is saved twice', async () => {
    const file = tmpDb();
    const db = new Database(file);
    await db.connect();

    const w = paper();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 10 });

    db.saveWallet(w.getState(), w.getTradeHistory());
    db.saveWallet(w.getState(), w.getTradeHistory());
    db.saveWallet(w.getState(), w.getTradeHistory());

    expect(db.loadWallet('p')!.trades).toHaveLength(1);
    db.close();
  });

  it('returns nothing for a wallet it has never seen', async () => {
    const db = new Database(tmpDb());
    await db.connect();
    expect(db.loadWallet('never')).toBeUndefined();
    db.close();
  });
});
