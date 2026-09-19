import { describe, it, expect } from 'vitest';
import { BaseStrategy } from '../src/strategies/strategy_interface';
import { MomentumStrategy } from '../src/strategies/trend/momentum_strategy';
import type { OrderRequest, Signal, WalletState } from '../src/types';

const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  walletId: 'w', marketId: 'm1', outcome: 'YES', side: 'SELL',
  price: 0.5, size: 10, strategy: 's', ...over,
});

class Probe extends BaseStrategy {
  readonly name = 's';
  released = 0;
  generateSignals(): Signal[] { return []; }
  exit(o: OrderRequest) {
    return this.queueExit(o, (filled) => { this.released += filled; });
  }
  retryWindow(ms: number) { this.exitRetryMs = ms; }
}

describe('queueExit', () => {
  it('does not release the position when the exit is merely queued', () => {
    const s = new Probe();
    expect(s.exit(order())).toBe(true);
    expect(s.drainExitOrders()).toHaveLength(1);
    expect(s.released).toBe(0); // queued is not filled
  });

  it('releases only on fill', () => {
    const s = new Probe();
    s.exit(order());
    s.notifyFill(order());
    expect(s.released).toBe(10);
  });

  it('releases only the quantity that actually filled', () => {
    const s = new Probe();
    s.exit(order({ size: 10 }));
    s.notifyFill(order({ size: 4 }));
    expect(s.released).toBe(4);
    s.notifyFill(order({ size: 6 }));
    expect(s.released).toBe(10);
  });

  it('refuses to queue a duplicate exit while one is working', () => {
    const s = new Probe();
    expect(s.exit(order())).toBe(true);
    expect(s.exit(order())).toBe(false); // would have stacked every tick
    expect(s.exit(order())).toBe(false);
  });

  it('allows a retry once the working exit has gone stale', async () => {
    const s = new Probe();
    s.retryWindow(20);
    expect(s.exit(order())).toBe(true);
    expect(s.exit(order())).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.exit(order())).toBe(true); // never filled, so retry is allowed
    expect(s.released).toBe(0);
  });

  it('lets a new exit through once the previous one completed', () => {
    const s = new Probe();
    s.exit(order());
    s.notifyFill(order());
    expect(s.exit(order())).toBe(true);
  });

  it('ignores fills that are not the working exit', () => {
    const s = new Probe();
    s.exit(order({ side: 'SELL' }));
    s.notifyFill(order({ side: 'BUY' })); // an entry, not our exit
    expect(s.released).toBe(0);
  });
});

/* ── End to end on a real strategy ── */

describe('MomentumStrategy exit', () => {
  it('keeps the position until the exit fills', () => {
    const s = new MomentumStrategy();
    s.initialize({
      wallet: { walletId: 'w', capitalAllocated: 1000, availableBalance: 1000 } as WalletState,
      config: {},
    });

    const managed = (s as unknown as { managedPositions: Map<string, unknown> }).managedPositions;
    managed.set('m1', {
      marketId: 'm1', outcome: 'YES', size: 10, entryPrice: 0.5,
      entryTime: Date.now(), direction: 'BULL', peakBps: 0,
    });

    // Queue an exit by hand through the same path managePositions uses.
    const queued = (s as unknown as { queueExit: Probe['exit'] }).queueExit.call(
      s,
      order({ strategy: s.name }),
      (filled: number) => {
        const pos = managed.get('m1') as { size: number };
        pos.size -= filled;
        if (pos.size <= 0) managed.delete('m1');
      },
    );
    expect(queued).toBe(true);
    expect(managed.has('m1')).toBe(true); // still held

    s.notifyFill(order({ strategy: s.name, size: 10 }));
    expect(managed.has('m1')).toBe(false); // released on fill
  });
});
