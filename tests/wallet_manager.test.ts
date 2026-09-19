import { describe, it, expect } from 'vitest';
import { WalletManager } from '../src/wallets/wallet_manager';

const walletConfig = {
  id: 'wallet_1',
  mode: 'PAPER' as const,
  strategy: 'momentum',
  capital: 500,
};

describe('WalletManager', () => {
  it('registers paper wallets', () => {
    const manager = new WalletManager();
    manager.registerWallet(walletConfig, walletConfig.strategy, false);
    const wallets = manager.listWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].mode).toBe('PAPER');
  });

  it('downgrades a LIVE wallet to PAPER when live trading is disabled', () => {
    const manager = new WalletManager();
    manager.registerWallet(
      { ...walletConfig, id: 'live_1', mode: 'LIVE' },
      walletConfig.strategy,
      false,
    );

    // The wallet still runs — it just cannot touch real money. Refusing it
    // outright would leave the bot with nothing to do; the property that
    // actually matters is that it is never silently LIVE.
    const wallets = manager.listWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].mode).toBe('PAPER');
  });

  it('honours LIVE only when live trading is explicitly enabled', () => {
    const manager = new WalletManager();
    manager.registerWallet(
      { ...walletConfig, id: 'live_2', mode: 'LIVE' },
      walletConfig.strategy,
      true,
    );
    expect(manager.listWallets()[0].mode).toBe('LIVE');
  });
});
