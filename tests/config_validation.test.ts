import { describe, it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { loadConfig } from '../src/core/config_loader';

const write = (yaml: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'c.yaml');
  fs.writeFileSync(f, yaml);
  return f;
};

const valid = `
environment:
  enable_live_trading: false
wallets:
  - id: w1
    mode: PAPER
    strategy: cross_market_arbitrage
    capital: 1000
    risk_limits:
      max_position_size: 100
      max_exposure_per_market: 200
      max_daily_loss: 50
      max_open_trades: 10
      max_drawdown: 0.2
`;

describe('config validation', () => {
  it('accepts a sound config', () => {
    expect(loadConfig(write(valid)).wallets).toHaveLength(1);
  });

  it('rejects a wallet with no capital instead of registering it at $0', () => {
    expect(() => loadConfig(write(valid.replace('capital: 1000', 'capital: 0'))))
      .toThrow(/capital must be > 0/);
  });

  it('rejects an unknown strategy and lists the real ones', () => {
    expect(() => loadConfig(write(valid.replace('cross_market_arbitrage', 'nope'))))
      .toThrow(/unknown strategy "nope".*available:/s);
  });

  it('rejects duplicate wallet ids', () => {
    expect(() => loadConfig(write(valid + valid.split('wallets:')[1]))).toThrow(/duplicate id/);
  });

  it('rejects a drawdown expressed as a percentage rather than a fraction', () => {
    expect(() => loadConfig(write(valid.replace('max_drawdown: 0.2', 'max_drawdown: 20'))))
      .toThrow(/max_drawdown must be a fraction/);
  });

  it('catches limits that can never both be satisfied', () => {
    // This shipped in the live config: exposure 1 with position size 25.
    expect(() =>
      loadConfig(write(valid.replace('max_exposure_per_market: 200', 'max_exposure_per_market: 1'))),
    ).toThrow(/below max_position_size/);
  });

  it('reports every problem at once, not one per run', () => {
    const broken = valid.replace('capital: 1000', 'capital: 0').replace('cross_market_arbitrage', 'nope');
    try {
      loadConfig(write(broken));
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/capital must be > 0/);
      expect(msg).toMatch(/unknown strategy/);
    }
  });
});
