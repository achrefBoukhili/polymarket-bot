import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest, MarketData } from '../../types';
import { logger } from '../../reporting/logs';

export class EnhancedLinearInventoryStrategy extends BaseStrategy {
  readonly name = 'market_making_fixed';
  private inventory = new Map<string, { yesShares: number; totalCost: number }>();
  private metadataCache = new Map<string, { tickSize: number; negRisk: boolean }>();

  private maxInventory = 50;
  private minSpread = 0.005;

  /** 1. FIX: Force Sync with Blockchain */
  private async getActualInventory(marketId: string, yesTokenId: string): Promise<number> {
    try {
      // 2026 SDK Method to check real balance in the Proxy Wallet
      const balance = await this.context.client.getTokenBalance(yesTokenId);
      const current = parseFloat(balance);

      // Update local memory so the next loop sees it
      this.inventory.set(marketId, { yesShares: current, totalCost: 0 });
      return current;
    } catch (e) {
      return this.inventory.get(marketId)?.yesShares || 0;
    }
  }

  async generateSignals(): Promise<Signal[]> {
    const signals: Signal[] = [];

    for (const market of this.markets.values()) {
      // Get the 'YES' token ID (index 0 in your data object)
      const yesTokenId = market.clobTokenIds[0];

      // REPAIR: Ensure we know we have shares before calculating signals
      const currentShares = await this.getActualInventory(market.marketId, yesTokenId);

      const spread = market.ask - market.bid;
      if (spread < this.minSpread) continue;

      const mid = (market.ask + market.bid) / 2;
      const skew = (currentShares / this.maxInventory) * 0.2 * 0.01;

      // BUY SIGNAL (Only if below cap)
      if (currentShares < this.maxInventory) {
        signals.push({
          marketId: market.marketId,
          outcome: 'YES',
          side: 'BUY',
          confidence: 0.5,
          edge: spread / 2 - skew, // Pay less as we get full
        });
      }

      // SELL SIGNAL (Triggered if we own shares)
      if (currentShares > 0) {
        signals.push({
          marketId: market.marketId,
          outcome: 'YES',
          side: 'SELL',
          confidence: 0.5,
          edge: spread / 2 + skew, // Sell for less (more attractive) as we get full
        });
      }
    }
    return signals;
  }

  override async sizePositions(signals: Signal[]): Promise<OrderRequest[]> {
    const orders: OrderRequest[] = [];
    for (const sig of super.sizePositions(signals)) {
      const market = this.markets.get(sig.marketId)!;
      const mid = (market.ask + market.bid) / 2;

      // Calculate Price
      let price = sig.side === 'BUY' ? mid - sig.edge : mid + sig.edge;

      // FIX: Competition Guard
      // If we are selling, we MUST be at or below the current Ask to be seen
      if (sig.side === 'SELL') {
        price = Math.min(price, market.ask);
      } else {
        price = Math.max(price, market.bid);
      }

      // Round to Tick (Standard 0.01 for Wrexham/Sports)
      const tick = 0.01;
      const finalPrice = Math.round(price / tick) * tick;

      orders.push({
        ...sig,
        price: Number(finalPrice.toFixed(2)),
        size: 10,
        postOnly: true, // Keep earning rebates
      });
    }
    return orders;
  }

  // Ensure notifyFill updates the SAME map keys used in generateSignals
  override notifyFill(order: OrderRequest): void {
    const inv = this.inventory.get(order.marketId) || { yesShares: 0, totalCost: 0 };
    if (order.side === 'BUY') {
      inv.yesShares += order.size;
    } else {
      inv.yesShares -= order.size;
    }
    this.inventory.set(order.marketId, inv);
    logger.info(`Inventory Updated: ${inv.yesShares} shares`);
  }
}
