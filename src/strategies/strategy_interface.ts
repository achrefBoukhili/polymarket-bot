import { MarketData, OrderRequest, Signal, WalletState } from '../types';

export interface StrategyContext {
  wallet: WalletState;
  config: Record<string, unknown>;
}

export interface StrategyInterface {
  readonly name: string;
  initialize(context: StrategyContext): Promise<void> | void;
  /** Called once at the start of each new poll cycle before any onMarketUpdate calls. */
  onSnapshotBegin(): void;
  onMarketUpdate(data: MarketData): Promise<void> | void;
  onTimer(): Promise<void> | void;
  generateSignals(): Promise<Signal[]> | Signal[];
  sizePositions(signals: Signal[]): Promise<OrderRequest[]> | OrderRequest[];
  submitOrders(orders: OrderRequest[]): Promise<void> | void;
  notifyFill(order: OrderRequest): void;
  managePositions(): Promise<void> | void;
  drainExitOrders(): OrderRequest[];
  shutdown(): Promise<void> | void;
}

export abstract class BaseStrategy implements StrategyInterface {
  abstract readonly name: string;
  protected context?: StrategyContext;

  /** Live market cache populated by onMarketUpdate() */
  protected markets = new Map<string, MarketData>();

  /**
   * Exit orders queued by managePositions() — the engine drains and
   * routes these through the wallet after each tick.
   */
  protected pendingExits: OrderRequest[] = [];

  /**
   * Per-market cooldown: prevents trading the same market more than once
   * within a cooldown window (default 60 seconds).
   */
  private tradeCooldowns = new Map<string, number>();
  protected cooldownMs = 60_000;

  initialize(context: StrategyContext): void {
    this.context = context;
  }

  /**
   * Called once at the start of every new poll snapshot, before any
   * onMarketUpdate() calls arrive for that cycle.
   *
   * Clears the strategy's market map so that only markets present in the
   * current API response survive — closed or inactive markets are dropped
   * automatically without any cap, TTL, or eviction heuristic.
   */
  onSnapshotBegin(): void {
    this.markets.clear();
  }

  onMarketUpdate(data: MarketData): void {
    this.markets.set(data.marketId, data);
    // Hard cap on how many markets the strategy will track at once
    // private static readonly MAX_MARKETS = 500;
    // Evict oldest entry when we exceed the cap (Map iterates insertion order)
    // if (this.markets.size > BaseStrategy.MAX_MARKETS) {
    //   const oldest = this.markets.keys().next().value as string;
    //   this.markets.delete(oldest);
    // }
  }

  onTimer(): void {
    return;
  }

  abstract generateSignals(): Signal[];

  /** Filter signals through cooldown, then size them */
  sizePositions(signals: Signal[]): OrderRequest[] {
    const now = Date.now();
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Prune expired cooldowns from memory
    for (const [key, lastTrade] of this.tradeCooldowns) {
      if (now - lastTrade > this.cooldownMs) {
        this.tradeCooldowns.delete(key);
      }
    }

    // Filter out signals for markets still in cooldown
    const filtered = signals.filter((s) => {
      const key = `${s.marketId}:${s.outcome}:${s.side}`;
      const lastTrade = this.tradeCooldowns.get(key) ?? 0;
      return now - lastTrade > this.cooldownMs;
    });

    return filtered.map((signal) => {
      // Record cooldown
      const key = `${signal.marketId}:${signal.outcome}:${signal.side}`;
      this.tradeCooldowns.set(key, now);

      // Use actual market price when available, fall back to 0.5 + edge
      const market = this.markets.get(signal.marketId);
      let price: number;
      if (market) {
        price =
          signal.outcome === 'YES'
            ? market.outcomePrices[0]
            : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
      } else {
        price = Number((0.5 + signal.edge).toFixed(4));
      }

      return {
        walletId,
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        price: Number(Math.max(0.01, Math.min(0.99, price)).toFixed(4)),
        size: Math.max(1, Math.floor(10 * signal.confidence)),
        strategy: this.name,
      };
    });
  }

  submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /**
   * Called by the engine after a successful fill.
   * Override in subclasses to track positions.
   */
  notifyFill(_order: OrderRequest): void {
    return;
  }

  managePositions(): void {
    return;
  }

  /** Return and clear any exit orders queued during managePositions() */
  drainExitOrders(): OrderRequest[] {
    const exits = this.pendingExits;
    this.pendingExits = [];
    return exits;
  }

  shutdown(): void {
    return;
  }
}
