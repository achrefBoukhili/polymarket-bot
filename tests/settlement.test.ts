import { describe, it, expect } from 'vitest';
import { settlementPrice, findSettlements, type ResolvableMarket } from '../src/execution/settlement';
import { PaperWallet } from '../src/wallets/paper_wallet';
import type { WalletConfig } from '../src/types';

describe('settlementPrice', () => {
  it('pays 1 to the winner and 0 to the loser', () => {
    const m: ResolvableMarket = { id: 'm1', closed: true, outcomePrices: '["1","0"]' };
    expect(settlementPrice(m, 'YES')).toBe(1);
    expect(settlementPrice(m, 'NO')).toBe(0);
  });

  it('handles a NO resolution', () => {
    const m: ResolvableMarket = { id: 'm1', closed: true, outcomePrices: '["0","1"]' };
    expect(settlementPrice(m, 'YES')).toBe(0);
    expect(settlementPrice(m, 'NO')).toBe(1);
  });

  it('refuses to settle a market that is still open', () => {
    expect(settlementPrice({ id: 'm1', closed: false, outcomePrices: '["1","0"]' }, 'YES')).toBeUndefined();
  });

  it('refuses to settle a closed market that has not actually resolved', () => {
    // Closed but the oracle has not spoken — settling here invents PnL.
    expect(settlementPrice({ id: 'm1', closed: true, outcomePrices: '["0.62","0.38"]' }, 'YES')).toBeUndefined();
  });

  it('survives missing or malformed prices', () => {
    expect(settlementPrice({ id: 'm1', closed: true }, 'YES')).toBeUndefined();
    expect(settlementPrice({ id: 'm1', closed: true, outcomePrices: 'not json' }, 'YES')).toBeUndefined();
    expect(settlementPrice({ id: 'm1', closed: true, outcomePrices: '[]' }, 'YES')).toBeUndefined();
  });
});

describe('findSettlements', () => {
  const held = [
    { marketId: 'live', outcome: 'YES' as const },
    { marketId: 'gone', outcome: 'YES' as const },
  ];

  it('never looks up a market that is still trading', async () => {
    const asked: string[][] = [];
    await findSettlements(held, new Set(['live', 'gone']), async (ids) => { asked.push(ids); return []; });
    expect(asked).toEqual([]); // nothing missing, no lookup
  });

  it('settles a position whose market left the feed and resolved', async () => {
    const out = await findSettlements(held, new Set(['live']), async () => [
      { id: 'gone', closed: true, outcomePrices: '["1","0"]' },
    ]);
    expect(out).toEqual([{ marketId: 'gone', outcome: 'YES', price: 1 }]);
  });

  it('does not settle when the market cannot be found', async () => {
    const out = await findSettlements(held, new Set(['live']), async () => []);
    expect(out).toEqual([]); // no data, no guess
  });
});

describe('PaperWallet.settle', () => {
  const wallet = () => {
    const w = new PaperWallet({ id: 'p', mode: 'PAPER', strategy: 's', capital: 1000 } as WalletConfig, 's');
    w.setMarketSource(() => ({ bid: 0.48, ask: 0.52, liquidity: 10_000 }));
    return w;
  };

  it('redeems a winner at $1 and books the gain', async () => {
    const w = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 10 });
    const paid = 1000 - w.getState().availableBalance;

    expect(w.settle('m1', 'YES', 1)).toBe(true);

    expect(w.getState().openPositions).toEqual([]);
    expect(w.getState().availableBalance).toBeCloseTo(1000 - paid + 10); // 10 shares × $1
    expect(w.getState().realizedPnl).toBeGreaterThan(0);
  });

  it('redeems a loser at $0 and books the loss', async () => {
    const w = wallet();
    await w.placeOrder({ marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.60, size: 10 });

    expect(w.settle('m1', 'YES', 0)).toBe(true);

    expect(w.getState().openPositions).toEqual([]);
    expect(w.getState().realizedPnl).toBeLessThan(0);
  });

  it('is a no-op for a position it does not hold', () => {
    expect(wallet().settle('nope', 'YES', 1)).toBe(false);
  });
});
