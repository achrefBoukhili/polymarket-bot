import { describe, it, expect } from 'vitest';
import { rejectionReason } from '../src/paper_trading/fill_simulator';
import { tradeFee, scheduleFromBps } from '../src/execution/fees';
import { PaperWallet } from '../src/wallets/paper_wallet';
import type { WalletConfig } from '../src/types';
import type { DepthBook } from '../src/data/book_feed';

const depth: DepthBook = {
  tokenId: 't1',
  bids: [{ price: 0.48, size: 1000 }],
  asks: [{ price: 0.52, size: 1000 }],
  tickSize: 0.01,
  minOrderSize: 5,
  updatedAt: Date.now(),
};
const book = { bid: 0.48, ask: 0.52, liquidity: 10_000, depth };

describe('venue rejections', () => {
  it('rejects a price off the tick grid', () => {
    expect(rejectionReason({ price: 0.4237, size: 10 }, book)).toMatch(/tick size/);
    expect(rejectionReason({ price: 0.42, size: 10 }, book)).toBeUndefined();
  });

  it('does not trip on floating-point dust', () => {
    // 0.07 / 0.01 is 6.999999… in binary floating point.
    expect(rejectionReason({ price: 0.07, size: 10 }, book)).toBeUndefined();
  });

  it('rejects a size below the market minimum', () => {
    expect(rejectionReason({ price: 0.5, size: 2 }, book)).toMatch(/below the market minimum/);
  });

  it('rejects a price outside (0,1)', () => {
    expect(rejectionReason({ price: 1, size: 10 }, book)).toMatch(/outside/);
    expect(rejectionReason({ price: 0, size: 10 }, book)).toMatch(/outside/);
  });

  it('allows anything when the book carries no constraints', () => {
    expect(rejectionReason({ price: 0.4237, size: 1 }, { bid: 0.4, ask: 0.5, liquidity: 1 })).toBeUndefined();
  });
});

describe('maker vs taker fees in paper', () => {
  const sports = { rate: 0.05, exponent: 1, takerOnly: true, enabled: true };

  const wallet = () => {
    const w = new PaperWallet({ id: 'p', mode: 'PAPER', strategy: 's', capital: 1000 } as WalletConfig, 's');
    w.setMarketSource(() => book);
    w.setFeeSource(() => sports);
    return w;
  };

  it('charges a taker who crosses the spread', async () => {
    const w = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 100 });
    // 100 × 0.05 × 0.52 × 0.48 ≈ 1.25
    expect(w.getFeesPaid()).toBeCloseTo(tradeFee(0.52, 100, sports, true), 2);
    expect(w.getFeesPaid()).toBeGreaterThan(0);
  });

  it('charges a maker NOTHING when their resting quote is hit', async () => {
    const w = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.45, size: 100 });
    expect(w.getTradeHistory()).toHaveLength(0); // resting

    // Market trades through our bid — we are the maker.
    w.onMarketUpdate({
      marketId: 'm1', question: 'q', slug: 's', outcomes: ['Yes', 'No'], outcomePrices: [0.44, 0.56],
      clobTokenIds: ['t1', 't2'], midPrice: 0.44, bid: 0.43, ask: 0.45, spread: 0.02,
      volume24h: 1, liquidity: 10_000, timestamp: Date.now(),
    });

    expect(w.getTradeHistory()).toHaveLength(1);
    expect(w.getFeesPaid()).toBe(0); // makers are never charged
  });
});

describe('fee rate from the exchange', () => {
  it('converts basis points to the documented decimal rate', () => {
    // Sports is 0.05 → 500 bps. 100 shares at 50¢ → $1.25 per the fee table.
    expect(tradeFee(0.5, 100, scheduleFromBps(500), true)).toBeCloseTo(1.25, 4);
  });

  it('treats a zero rate as no schedule at all', () => {
    expect(scheduleFromBps(0)).toBeUndefined();
    expect(tradeFee(0.5, 100, scheduleFromBps(0), true)).toBe(0);
  });
});

describe('runtime wallet wiring', () => {
  it('gives a wallet added after startup the same feeds as one from config', async () => {
    const { WalletManager } = await import('../src/wallets/wallet_manager');
    const manager = new WalletManager();

    // Hook registered before any wallet exists, as cli.ts does.
    const wired: string[] = [];
    manager.onWalletAdded((w) => { wired.push(w.getState().walletId); });

    manager.registerWallet(
      { id: 'from_config', mode: 'PAPER', strategy: 's', capital: 100 } as never, 's', false,
    );
    const runtime = new PaperWallet(
      { id: 'from_dashboard', mode: 'PAPER', strategy: 's', capital: 100 } as WalletConfig, 's',
    );
    manager.addWallet(runtime);

    expect(wired).toEqual(['from_config', 'from_dashboard']);
  });

  it('applies the hook to wallets that already exist', async () => {
    const { WalletManager } = await import('../src/wallets/wallet_manager');
    const manager = new WalletManager();
    manager.addWallet(new PaperWallet(
      { id: 'early', mode: 'PAPER', strategy: 's', capital: 100 } as WalletConfig, 's',
    ));

    const wired: string[] = [];
    manager.onWalletAdded((w) => { wired.push(w.getState().walletId); });
    expect(wired).toEqual(['early']);
  });
});
