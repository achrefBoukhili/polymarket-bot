import { logger } from '../reporting/logs';

/**
 * Structural deps so callers (and tests) can pass anything with the right
 * shape — no mocking framework, no interfaces with one implementation.
 */
export interface ShutdownDeps {
  engine: { stop(): void };
  walletManager: {
    listWallets(): Array<{ walletId: string }>;
    getWallet(walletId: string): { cancelAllOrders?(): Promise<void> } | undefined;
  };
  dashboardServer: { stop(): void };
  whaleService?: { stop(): void };
}

/**
 * Take the bot off the market, in the only order that is safe:
 *
 *   1. Stop the engine first — otherwise a tick can post fresh quotes while
 *      we are busy cancelling, and we exit with orders we never saw.
 *   2. Cancel resting orders on every wallet that has any.
 *   3. Tear down the background services.
 *
 * A cancel failure on one wallet is logged loudly but never blocks the
 * others: money left on the book is the thing we are here to prevent.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  deps.engine.stop();

  for (const { walletId } of deps.walletManager.listWallets()) {
    const wallet = deps.walletManager.getWallet(walletId);
    if (!wallet?.cancelAllOrders) continue;
    try {
      await wallet.cancelAllOrders();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(
        { walletId, error },
        `FAILED to cancel orders for ${walletId} — orders may still be resting on the book`,
      );
    }
  }

  deps.whaleService?.stop();
  deps.dashboardServer.stop();
}
