import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/execution/retry';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { RiskStateStore } from '../src/risk/risk_state';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type { OrderRequest, WalletState } from '../src/types';

const tmpStore = () => new RiskStateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), 'r.json'));

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const r = await withRetry('x', async () => { calls++; return 'ok'; });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    const r = await withRetry('x', async () => {
      if (++calls < 3) throw new Error('boom');
      return 'ok';
    }, 3, 1);
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the configured attempts and rethrows', async () => {
    let calls = 0;
    await expect(withRetry('x', async () => { calls++; throw new Error('always'); }, 3, 1))
      .rejects.toThrow('always');
    expect(calls).toBe(3);
  });
});

const wallet = (): WalletState => ({
  walletId: 'w1', mode: 'LIVE', assignedStrategy: 'mm',
  capitalAllocated: 1000, availableBalance: 1000, openPositions: [], realizedPnl: 0,
  riskLimits: { maxPositionSize: 1000, maxExposurePerMarket: 1000, maxDailyLoss: 500, maxOpenTrades: 50, maxDrawdown: 0.5 },
});

const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  walletId: 'w1', marketId: 'm1', outcome: 'YES', side: 'BUY',
  price: 0.5, size: 10, strategy: 'mm', ...over,
});

describe('minimum notional', () => {
  it('rejects the sub-$1 order that small-capital sizing produces', () => {
    const e = new RiskEngine(new KillSwitch(), tmpStore());
    // capital 5 → floor((5*0.01)/0.5) = 0 → clamped to 1 share → $0.50
    const r = e.check(order({ size: 1, price: 0.5 }), wallet());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/below exchange minimum/);
  });

  it('accepts an order at or above the minimum', () => {
    const e = new RiskEngine(new KillSwitch(), tmpStore());
    expect(e.check(order({ size: 10, price: 0.5 }), wallet()).ok).toBe(true);
  });
});
