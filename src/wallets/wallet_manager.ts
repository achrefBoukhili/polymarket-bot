import { PaperWallet } from './paper_wallet';
import { PolymarketWallet } from './polymarket_wallet';
import { WalletState, WalletConfig, TradeRecord, FillResult } from '../types';
import { logger } from '../reporting/logs';

export interface ExecutionWallet {
  getState(): WalletState;
  getTradeHistory(): TradeRecord[];
  placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    tokenId?: string;
  }): Promise<FillResult>;
  updateBalance(delta: number): void;
  /** Optional display name for the dashboard (defaults to walletId) */
  getDisplayName?(): string;
  setDisplayName?(name: string): void;
  /** Feed the simulated book (PAPER only) */
  setMarketSource?(source: (marketId: string) => { bid: number; ask: number; liquidity: number } | undefined): void;
  /** Per-market fee schedule (PAPER only) */
  setFeeSource?(source: (marketId: string) => import('../execution/fees').FeeSchedule | undefined): void;
  /** Work resting orders against a fresh snapshot (PAPER only) */
  onMarketUpdate?(data: import('../types').MarketData): void;
  /** Sync positions, resting orders and cash from the exchange (LIVE only) */
  reconcile?(): Promise<void>;
  /** PnL decomposition (PAPER) */
  getAttribution?(): import('../reporting/attribution').Attribution;
  /** Whether the result is distinguishable from noise (PAPER) */
  getSignificance?(): import('../reporting/statistics').Significance;
  /** Redeem a position in a resolved market (PAPER; LIVE settles on-chain) */
  settle?(marketId: string, outcome: 'YES' | 'NO', price: number): boolean;
  /** Restore a persisted snapshot (PAPER only — LIVE reconciles instead) */
  restore?(state: Partial<WalletState>, trades: TradeRecord[]): void;
  /** Cancel resting orders in one market (cancel-replace) */
  cancelOrdersForMarket?(marketId: string): Promise<number>;
  /** Cancel all resting exchange orders (LIVE only — paper wallets have none) */
  cancelAllOrders?(): Promise<void>;
  /** Update risk limits at runtime */
  updateRiskLimits?(limits: Partial<import('../types').RiskLimits>): void;
}

export class WalletManager {
  private readonly wallets = new Map<string, ExecutionWallet>();

  /**
   * Applied to every wallet as it joins, however it joins.
   *
   * Wiring wallets in a one-shot loop at startup silently skipped anything
   * created later from the dashboard: those wallets kept the default empty
   * market source, so nothing they ordered could ever fill.
   */
  private readonly onAdd: Array<(wallet: ExecutionWallet) => void> = [];

  /** Register a hook and apply it to wallets already present. */
  onWalletAdded(hook: (wallet: ExecutionWallet) => void): void {
    this.onAdd.push(hook);
    for (const wallet of this.wallets.values()) hook(wallet);
  }

  private wire(wallet: ExecutionWallet): void {
    for (const hook of this.onAdd) hook(wallet);
  }

  registerWallet(config: WalletConfig, assignedStrategy: string, enableLive: boolean): void {
    if (this.wallets.has(config.id)) {
      throw new Error(`Wallet ${config.id} already registered`);
    }

    if (config.mode === 'LIVE' && !enableLive) {
      logger.warn(
        { walletId: config.id },
        'LIVE trading requested but ENABLE_LIVE_TRADING is false — falling back to PAPER mode',
      );
      config = { ...config, mode: 'PAPER' };
    }

    const wallet =
      config.mode === 'LIVE'
        ? new PolymarketWallet(config, assignedStrategy)
        : new PaperWallet(config, assignedStrategy);

    this.wallets.set(config.id, wallet);

    this.wire(this.wallets.get(config.id)!);
    const state = wallet.getState();
    logger.info(
      {
        walletId: state.walletId,
        mode: state.mode,
        strategy: state.assignedStrategy,
        capital: state.capitalAllocated,
      },
      `Registered wallet ${state.walletId} (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }

  getWallet(walletId: string): ExecutionWallet | undefined {
    return this.wallets.get(walletId);
  }

  listWallets(): WalletState[] {
    return Array.from(this.wallets.values()).map((wallet) => wallet.getState());
  }

  getTradeHistory(walletId: string): TradeRecord[] {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return [];
    return wallet.getTradeHistory();
  }

  getAllTradeHistories(): Map<string, TradeRecord[]> {
    const map = new Map<string, TradeRecord[]>();
    for (const [id, wallet] of this.wallets) {
      map.set(id, wallet.getTradeHistory());
    }
    return map;
  }

  removeWallet(walletId: string): boolean {
    if (!this.wallets.has(walletId)) {
      return false;
    }
    this.wallets.delete(walletId);
    logger.info({ walletId }, `Wallet ${walletId} removed`);
    return true;
  }

  registerExternalWallet(walletId: string, wallet: ExecutionWallet): void {
    if (this.wallets.has(walletId)) {
      throw new Error(`Wallet ${walletId} already registered`);
    }
    this.wallets.set(walletId, wallet);
    this.wire(this.wallets.get(walletId)!);
  }

  addWallet(wallet: ExecutionWallet): void {
    const state = wallet.getState();
    if (this.wallets.has(state.walletId)) {
      throw new Error(`Wallet ${state.walletId} already registered`);
    }
    this.wallets.set(state.walletId, wallet);
    this.wire(wallet);
    logger.info(
      {
        walletId: state.walletId,
        mode: state.mode,
        strategy: state.assignedStrategy,
        capital: state.capitalAllocated,
      },
      `Wallet ${state.walletId} added at runtime (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }
}
