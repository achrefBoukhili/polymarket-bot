import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  utcDayKey, newRiskState, rollDay, dailyPnl, markToMarket, drawdownPct, RiskStateStore,
} from '../src/risk/risk_state';
import { KillSwitch } from '../src/risk/kill_switch';
import { RiskEngine } from '../src/risk/risk_engine';
import type { OrderRequest, WalletState, Position } from '../src/types';

const tmpStore = () =>
  new RiskStateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'risk-')), 'risk.json'));

const DAY1 = Date.parse('2026-03-10T23:00:00Z');
const DAY2 = Date.parse('2026-03-11T01:00:00Z');

describe('daily anchor (item 6)', () => {
  it('measures PnL since the start of the UTC day, not lifetime', () => {
    // Wallet is +100 lifetime, but started today at +90 → today is only +10.
    const state = { dayKey: utcDayKey(DAY1), dayStartRealizedPnl: 90, peakEquity: 0 };
    expect(dailyPnl(state, 100)).toBe(10);
  });

  it('re-anchors when the UTC day turns over', () => {
    const before = newRiskState(-40, 0, DAY1);
    expect(dailyPnl(before, -40)).toBe(0);

    const after = rollDay(before, -40, DAY2);
    expect(after.dayKey).toBe('2026-03-11');
    expect(after.dayStartRealizedPnl).toBe(-40);
    // Yesterday's -40 no longer counts against today.
    expect(dailyPnl(after, -40)).toBe(0);
  });

  it('does not re-anchor within the same day', () => {
    const state = newRiskState(0, 0, DAY1);
    expect(rollDay(state, -999, DAY1)).toBe(state);
  });

  it('survives a restart', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'risk-')), 'risk.json');
    const first = new RiskStateStore(file);
    first.set('w1', { dayKey: '2026-03-10', dayStartRealizedPnl: -25, peakEquity: 100 });

    const reloaded = new RiskStateStore(file); // fresh process
    expect(reloaded.get('w1')).toEqual({ dayKey: '2026-03-10', dayStartRealizedPnl: -25, peakEquity: 100 });
  });
});

describe('kill switch (item 7)', () => {
  it('fires its hooks exactly once and reports why', () => {
    const ks = new KillSwitch();
    const fired: string[] = [];
    ks.onActivate((reason) => void fired.push(reason));

    ks.activate('daily loss');
    ks.activate('again');

    expect(fired).toEqual(['daily loss']);
    expect(ks.isActive()).toBe(true);
    expect(ks.getStatus().reason).toBe('daily loss');
  });

  it('can be released and re-armed', () => {
    const ks = new KillSwitch();
    ks.activate('x');
    ks.deactivate();
    expect(ks.isActive()).toBe(false);
    expect(ks.getStatus().reason).toBeUndefined();

    const fired: string[] = [];
    ks.onActivate((r) => void fired.push(r));
    ks.activate('y');
    expect(fired).toEqual(['y']);
  });
});

describe('mark to market (item 9)', () => {
  const pos: Position[] = [{ marketId: 'm1', outcome: 'YES', size: 100, avgPrice: 0.5, realizedPnl: 0 }];

  it('sees a loss when the mark falls — cost basis never could', () => {
    const { unrealizedPnl } = markToMarket(pos, () => 0.25);
    expect(unrealizedPnl).toBe(-25);
  });

  it('flags positions it cannot price instead of pretending', () => {
    const { unpriced, markedValue } = markToMarket(pos, () => undefined);
    expect(unpriced).toBe(1);
    expect(markedValue).toBe(50); // fell back to cost
  });

  it('measures drawdown peak-to-trough', () => {
    expect(drawdownPct(100, 80)).toBeCloseTo(0.2);
    expect(drawdownPct(100, 120)).toBe(0); // above peak is not a drawdown
    expect(drawdownPct(0, -5)).toBe(0);
  });
});

/* ── Integration: the checks as the router actually calls them ── */

const wallet = (over: Partial<WalletState> = {}): WalletState => ({
  walletId: 'w1', mode: 'LIVE', assignedStrategy: 'market_making',
  capitalAllocated: 100, availableBalance: 100, openPositions: [], realizedPnl: 0,
  riskLimits: { maxPositionSize: 100, maxExposurePerMarket: 200, maxDailyLoss: 10, maxOpenTrades: 5, maxDrawdown: 0.2 },
  ...over,
});

const order: OrderRequest = {
  walletId: 'w1', marketId: 'm1', outcome: 'YES', side: 'BUY',
  price: 0.5, size: 10, strategy: 'market_making',
};

describe('RiskEngine', () => {
  it('trips the kill switch when today’s loss breaches the limit', () => {
    const ks = new KillSwitch();
    const engine = new RiskEngine(ks, tmpStore());

    // Seed today's anchor at 0, then report a -15 realised PnL (limit is 10).
    engine.check(order, wallet());
    const result = engine.check(order, wallet({ realizedPnl: -15 }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
    expect(ks.isActive()).toBe(true);
  });

  it('blocks a drawdown that only mark-to-market can see', () => {
    const ks = new KillSwitch();
    const engine = new RiskEngine(ks, tmpStore());
    const held = wallet({
      availableBalance: 50,
      openPositions: [{ marketId: 'm1', outcome: 'YES', size: 100, avgPrice: 0.5, realizedPnl: 0 }],
    });

    engine.setMarkPriceSource(() => 0.5); // at cost — establishes the peak
    expect(engine.check(order, held).ok).toBe(true);

    engine.setMarkPriceSource(() => 0.2); // position lost 60% of its value
    const result = engine.check(order, held);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/drawdown/i);
  });

  it('blocks everything once the switch is active', () => {
    const ks = new KillSwitch();
    const engine = new RiskEngine(ks, tmpStore());
    ks.activate('test');
    expect(engine.check(order, wallet()).ok).toBe(false);
  });
});
