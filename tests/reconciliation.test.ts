import { describe, it, expect } from 'vitest';
import {
  normalizeTrade,
  rebuildPositions,
  computeAvailableBalance,
  parseUsdc,
  type RawTrade,
} from '../src/wallets/reconciliation';

const US = '0xus';
const THEM = '0xthem';
const ours = new Set([US]);

const base: RawTrade = {
  id: 't1',
  market: 'cond1',
  asset_id: 'tok1',
  side: 'BUY',
  size: '10',
  price: '0.5',
  status: 'CONFIRMED',
  match_time: '1700000000',
  outcome: 'Yes',
};

describe('normalizeTrade', () => {
  it('uses the top-level side when we were the taker', () => {
    const [fill] = normalizeTrade({ ...base, trader_side: 'TAKER' }, ours);
    expect(fill).toMatchObject({ side: 'BUY', size: 10, price: 0.5, tokenId: 'tok1' });
  });

  it('does NOT use the top-level side when we were the maker — that is the taker side', () => {
    // Taker BOUGHT, so we (the maker) SOLD. Reading trade.side would invert us.
    const fills = normalizeTrade(
      {
        ...base,
        side: 'BUY',
        trader_side: 'MAKER',
        maker_orders: [
          { order_id: 'o1', maker_address: US, matched_amount: '6', price: '0.48', asset_id: 'tok1', outcome: 'Yes', side: 'SELL' },
        ],
      },
      ours,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: 'SELL', size: 6, price: 0.48 });
  });

  it('ignores other makers in the same match', () => {
    const fills = normalizeTrade(
      {
        ...base,
        trader_side: 'MAKER',
        maker_orders: [
          { order_id: 'o1', maker_address: THEM, matched_amount: '99', price: '0.9', asset_id: 'tok1', outcome: 'Yes', side: 'SELL' },
          { order_id: 'o2', maker_address: US, matched_amount: '4', price: '0.48', asset_id: 'tok1', outcome: 'Yes', side: 'SELL' },
        ],
      },
      ours,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].size).toBe(4);
  });

  it('drops trades that never settled', () => {
    expect(normalizeTrade({ ...base, status: 'FAILED', trader_side: 'TAKER' }, ours)).toEqual([]);
    expect(normalizeTrade({ ...base, status: 'RETRYING', trader_side: 'TAKER' }, ours)).toEqual([]);
  });
});

describe('rebuildPositions', () => {
  const fill = (o: Partial<Parameters<typeof rebuildPositions>[0][0]>) => ({
    fillId: 'f', tokenId: 'tok1', conditionId: 'c', outcome: 'Yes',
    side: 'BUY' as const, price: 0.5, size: 10, timestamp: 1, ...o,
  });

  it('averages cost across buys', () => {
    const { positions } = rebuildPositions([
      fill({ fillId: 'a', price: 0.4, size: 10, timestamp: 1 }),
      fill({ fillId: 'b', price: 0.6, size: 10, timestamp: 2 }),
    ]);
    expect(positions[0]).toMatchObject({ size: 20, avgPrice: 0.5 });
  });

  it('realises PnL against cost basis on a sell', () => {
    const { positions, realizedPnl } = rebuildPositions([
      fill({ fillId: 'a', side: 'BUY', price: 0.4, size: 10, timestamp: 1 }),
      fill({ fillId: 'b', side: 'SELL', price: 0.6, size: 10, timestamp: 2 }),
    ]);
    expect(realizedPnl).toBeCloseTo(2);
    expect(positions).toEqual([]); // fully closed
  });

  it('is idempotent — the same fills always produce the same books', () => {
    const fills = [
      fill({ fillId: 'a', price: 0.4, size: 10, timestamp: 1 }),
      fill({ fillId: 'b', side: 'SELL', price: 0.6, size: 4, timestamp: 2 }),
    ];
    expect(rebuildPositions(fills)).toEqual(rebuildPositions([...fills, ...[]]));
    // and re-running on the same input never compounds
    const once = rebuildPositions(fills);
    const twice = rebuildPositions(fills);
    expect(twice.realizedPnl).toBe(once.realizedPnl);
  });

  it('applies fills in time order regardless of arrival order', () => {
    const late = fill({ fillId: 'b', side: 'SELL', price: 0.6, size: 10, timestamp: 2 });
    const early = fill({ fillId: 'a', side: 'BUY', price: 0.4, size: 10, timestamp: 1 });
    expect(rebuildPositions([late, early]).realizedPnl).toBeCloseTo(2);
  });
});

describe('computeAvailableBalance', () => {
  it('is capped by the real chain balance, not the configured allocation', () => {
    expect(computeAvailableBalance({ chainCash: 3, capitalAllocated: 100, positionCost: 0, reservedCollateral: 0 })).toBe(3);
  });

  it('is capped by the configured allocation when the chain has more', () => {
    expect(computeAvailableBalance({ chainCash: 500, capitalAllocated: 5, positionCost: 0, reservedCollateral: 0 })).toBe(5);
  });

  it('subtracts collateral committed to resting orders', () => {
    expect(computeAvailableBalance({ chainCash: 10, capitalAllocated: 10, positionCost: 0, reservedCollateral: 4 })).toBe(6);
  });

  it('never goes negative', () => {
    expect(computeAvailableBalance({ chainCash: 1, capitalAllocated: 5, positionCost: 9, reservedCollateral: 3 })).toBe(0);
  });
});

describe('parseUsdc', () => {
  it('converts 6-decimal base units', () => {
    expect(parseUsdc('5000000')).toBe(5);
    expect(parseUsdc('1234567')).toBeCloseTo(1.234567);
    expect(parseUsdc(undefined)).toBe(0);
    expect(parseUsdc('garbage')).toBe(0);
  });
});
