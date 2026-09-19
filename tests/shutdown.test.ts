import { describe, it, expect } from 'vitest';
import { gracefulShutdown, type ShutdownDeps } from '../src/core/shutdown';

/** Records the order every step ran in, so we can assert the sequence. */
function harness(cancels: Record<string, () => Promise<void>>) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    engine: { stop: () => void calls.push('engine.stop') },
    walletManager: {
      listWallets: () => Object.keys(cancels).map((walletId) => ({ walletId })),
      getWallet: (id) => ({
        cancelAllOrders: async () => {
          calls.push(`cancel:${id}`);
          await cancels[id]();
        },
      }),
    },
    dashboardServer: { stop: () => void calls.push('dashboard.stop') },
    whaleService: { stop: () => void calls.push('whale.stop') },
  };
  return { deps, calls };
}

const ok = async () => {};
const boom = async () => {
  throw new Error('CLOB unreachable');
};

describe('gracefulShutdown', () => {
  it('stops the engine before cancelling, so no tick can post new quotes mid-cancel', async () => {
    const { deps, calls } = harness({ w1: ok, w2: ok });
    await gracefulShutdown(deps);
    expect(calls[0]).toBe('engine.stop');
    expect(calls).toEqual(['engine.stop', 'cancel:w1', 'cancel:w2', 'whale.stop', 'dashboard.stop']);
  });

  it('keeps cancelling other wallets after one fails, and still tears down', async () => {
    const { deps, calls } = harness({ w1: boom, w2: ok });
    await expect(gracefulShutdown(deps)).resolves.toBeUndefined();
    expect(calls).toContain('cancel:w2');
    expect(calls).toContain('dashboard.stop');
  });

  it('skips paper wallets, which have no resting orders to cancel', async () => {
    const calls: string[] = [];
    const deps: ShutdownDeps = {
      engine: { stop: () => void calls.push('engine.stop') },
      walletManager: {
        listWallets: () => [{ walletId: 'paper' }],
        getWallet: () => ({}), // no cancelAllOrders
      },
      dashboardServer: { stop: () => void calls.push('dashboard.stop') },
    };
    await gracefulShutdown(deps);
    expect(calls).toEqual(['engine.stop', 'dashboard.stop']);
  });
});
