import { describe, it, expect } from 'vitest';
import { PolymarketWallet, matchedShares } from '../src/wallets/polymarket_wallet';
import type { WalletConfig } from '../src/types';

describe('matchedShares', () => {
  const req = 10;

  it('reads shares from takingAmount on a BUY', () => {
    expect(matchedShares({ status: 'matched', makingAmount: '5', takingAmount: '10' }, 'BUY', req)).toBe(10);
  });

  it('reads shares from makingAmount on a SELL', () => {
    expect(matchedShares({ status: 'matched', makingAmount: '10', takingAmount: '5' }, 'SELL', req)).toBe(10);
  });

  it('reports NO fill for a resting order', () => {
    for (const status of ['live', 'delayed', 'unmatched']) {
      expect(matchedShares({ status, makingAmount: '0', takingAmount: '0' }, 'BUY', req)).toBe(0);
    }
  });

  it('reports a partial fill when only part crossed', () => {
    expect(matchedShares({ status: 'live', makingAmount: '0', takingAmount: '3' }, 'BUY', req)).toBe(3);
  });

  it('falls back to status when amounts are missing', () => {
    expect(matchedShares({ status: 'matched' } as never, 'BUY', req)).toBe(req);
    expect(matchedShares({ status: 'live' } as never, 'BUY', req)).toBe(0);
    expect(matchedShares(undefined, 'BUY', req)).toBe(0);
  });

  it('never reports more than was asked for', () => {
    expect(matchedShares({ status: 'matched', makingAmount: '0', takingAmount: '999' }, 'BUY', req)).toBe(req);
  });
});

/** Minimal stand-in for the CLOB client — returns whatever response we hand it. */
function fakeClient(response: unknown) {
  return {
    updateBalanceAllowance: async () => undefined,
    createAndPostOrder: async () => response,
    cancelAll: async () => ({ canceled: [] }),
  };
}

function wallet(client: unknown) {
  const config: WalletConfig = { id: 'w', mode: 'LIVE', strategy: 'market_making', capital: 100 } as WalletConfig;
  const w = new PolymarketWallet(config, 'market_making');
  (w as unknown as { clobClient: unknown }).clobClient = client;
  return w;
}

const order = { marketId: 'm1', outcome: 'YES' as const, side: 'BUY' as const, price: 0.5, size: 10, tokenId: 't1' };

describe('PolymarketWallet accounting', () => {
  it('books NO position and NO trade for an order that only rests', async () => {
    const w = wallet(fakeClient({ success: true, orderID: 'o1', status: 'live', makingAmount: '0', takingAmount: '0' }));

    const result = await w.placeOrder(order);

    expect(result).toEqual({ orderId: 'o1', filledSize: 0, restingSize: 10 });
    expect(w.getState().openPositions).toEqual([]);
    expect(w.getTradeHistory()).toEqual([]);
    expect(w.getState().realizedPnl).toBe(0);
    // $5 of collateral is committed to the resting bid, so it is not available.
    expect(w.getState().availableBalance).toBe(95);
    expect(w.getOpenOrders()).toHaveLength(1);
  });

  it('books the position only for the matched portion of a partial fill', async () => {
    const w = wallet(fakeClient({ success: true, orderID: 'o2', status: 'live', makingAmount: '0', takingAmount: '4' }));

    const result = await w.placeOrder(order);

    expect(result).toEqual({ orderId: 'o2', filledSize: 4, restingSize: 6 });
    expect(w.getState().openPositions).toEqual([
      { marketId: 'm1', outcome: 'YES', size: 4, avgPrice: 0.5, realizedPnl: 0 },
    ]);
    expect(w.getTradeHistory()).toHaveLength(1);
    // $2 spent on the fill, $3 reserved against the 6 still resting.
    expect(w.getState().availableBalance).toBe(95);
  });

  it('releases reserved collateral when resting orders are cancelled', async () => {
    const w = wallet(fakeClient({ success: true, orderID: 'o3', status: 'live', makingAmount: '0', takingAmount: '0' }));

    await w.placeOrder(order);
    expect(w.getState().availableBalance).toBe(95);

    await w.cancelAllOrders();

    expect(w.getState().availableBalance).toBe(100);
    expect(w.getOpenOrders()).toEqual([]);
  });

  it('throws on a rejection reported via errorMsg', async () => {
    const w = wallet(fakeClient({ success: false, errorMsg: 'not enough balance', orderID: '', status: '' }));
    await expect(w.placeOrder(order)).rejects.toThrow(/not enough balance/);
    expect(w.getTradeHistory()).toEqual([]);
  });
});
