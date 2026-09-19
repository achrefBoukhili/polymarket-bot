import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, OrderRequest, MarketData, OrderSide } from '../../types';
import { logger } from '../../reporting/logs';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
export class EnhancedLinearInventoryStrategyV2 extends BaseStrategy {
  readonly name = 'enhanced_linear_inventory_v2';

  // ========== CONFIGURATION ==========
  private readonly config = {
    maxInventory: 50, // Max YES/NO shares per market
    minSpreadBps: 200, // Minimum spread: 2¢ (covers fees + buffer)
    baseOrderSize: 10, // Base size before dynamic adjustments
    maxSkewBps: 500, // Max inventory skew: 5¢
    reconciliationIntervalMs: 30000, // Sync with blockchain every 30s
    maxLossPerMarket: 100, // Circuit breaker: stop loss per market (USDC)
    dailyLossLimit: 500, // Global daily loss limit
    minConfidence: 0.3, // Minimum confidence to generate signal
    timeDecayThresholdHours: 24, // Start reducing size 24h before resolution
  };

  // ========== STATE MANAGEMENT ==========
  private inventory = new Map<
    string,
    {
      yesShares: number;
      noShares: number;
      yesCostBasis: number; // Total USDC spent on YES
      noCostBasis: number; // Total USDC spent on NO
    }
  >();

  private metadataCache = new Map<
    string,
    {
      tickSize: number;
      feeRateBps: number;
      feesEnabled: boolean;
      resolutionTime?: number;
    }
  >();

  private marketPnL = new Map<string, number>(); // Realized P&L per market
  private dailyPnL = 0; // Global daily P&L
  private lastReconciliation = new Map<string, number>(); // Timestamp per market
  private pendingOrders = new Map<string, number>(); // Track reserved capital per market

  private getClient() {
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY!, provider);
    const clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137, // Polygon Chain ID
      signer,
    );
    return clobClient;
  }

  constructor() {
    super();
    // Explicitly bind context in case BaseStrategy doesn't

    if (!this?.client) {
      this.client = this.getClient();
      logger.info(`[${this.name}] Context validated ✅`);
    }
    logger.info(`[${this.name}] Context validated ✅`);
  }

  // ========== LIFECYCLE ==========
  async initialize(): Promise<void> {
    logger.info(`[${this.name}] Initializing...`);
    // Don't pre-fetch metadata here. Let generateSignals() load it lazily.
    this.startReconciliationLoop();
    logger.info(`[${this.name}] Ready`);
  }

  private startReconciliationLoop(): void {
    setInterval(async () => {
      for (const market of this.markets.values()) {
        await this.reconcileInventory(market.marketId, market.clobTokenIds);
      }
    }, this.config.reconciliationIntervalMs);
  }

  // Remove: refreshAllMetadata(), refreshMarketMetadata(), startReconciliationLoop()
  // Replace with these robust methods:

  private async ensureMetadata(marketId: string): Promise<{
    tickSize: number;
    feeRateBps: number;
    feesEnabled: boolean;
    resolutionTime?: number;
  }> {
    const cached = this.metadataCache.get(marketId);
    if (cached) return cached;

    logger.info(`📡 Fetching metadata for ${marketId} (cache miss)...`);
    try {
      const info = await this.client.getMarketInfo(marketId);
      if (!info) throw new Error('getMarketInfo returned null/undefined');

      const meta = {
        tickSize: Number(info.tickSize) || 0.01,
        feeRateBps: Number(info.feeRateBps) || 180,
        feesEnabled: Boolean(info.feesEnabled) ?? true,
        resolutionTime: info.resolutionTime ? Number(info.resolutionTime) : undefined,
      };

      this.metadataCache.set(marketId, meta);
      logger.info(
        `✅ Cached metadata for ${marketId}: tick=${meta.tickSize} fee=${meta.feeRateBps}bps`,
      );
      return meta;
    } catch (e) {
      logger.error(`❌ Failed to fetch metadata for ${marketId}: ${e.message}`);
      // Safe fallback so strategy doesn't stall
      const fallback = { tickSize: 0.01, feeRateBps: 180, feesEnabled: true };
      this.metadataCache.set(marketId, fallback);
      return fallback;
    }
  }

  // ========== INVENTORY MANAGEMENT ==========
  private async reconcileInventory(marketId: string, tokenIds: [string, string]): Promise<void> {
    const [yesTokenId, noTokenId] = tokenIds;
    const now = Date.now();
    const lastSync = this.lastReconciliation.get(marketId) || 0;

    // Rate limit: don't sync too frequently
    if (now - lastSync < 10000) return;

    try {
      const [yesBalance, noBalance] = await Promise.all([
        this.client.getTokenBalance(yesTokenId).catch(() => '0'),
        this.client.getTokenBalance(noTokenId).catch(() => '0'),
      ]);

      const chainYes = parseFloat(yesBalance) || 0;
      const chainNo = parseFloat(noBalance) || 0;
      const local = this.inventory.get(marketId) || {
        yesShares: 0,
        noShares: 0,
        yesCostBasis: 0,
        noCostBasis: 0,
      };

      // Log and correct significant drifts
      const yesDrift = Math.abs(chainYes - local.yesShares);
      const noDrift = Math.abs(chainNo - local.noShares);

      if (yesDrift > 0.1 || noDrift > 0.1) {
        logger.warn(`Inventory drift for ${marketId}:
          YES local=${local.yesShares.toFixed(2)} chain=${chainYes.toFixed(2)} (Δ${yesDrift.toFixed(2)})
          NO  local=${local.noShares.toFixed(2)} chain=${chainNo.toFixed(2)} (Δ${noDrift.toFixed(2)})`);

        // Preserve cost basis, only sync share counts
        this.inventory.set(marketId, {
          yesShares: chainYes,
          noShares: chainNo,
          yesCostBasis: local.yesCostBasis,
          noCostBasis: local.noCostBasis,
        });
      }

      this.lastReconciliation.set(marketId, now);
    } catch (e) {
      logger.error(`Reconciliation failed for ${marketId}: ${e.message}`);
      // Continue with local inventory; don't silently fallback
    }
  }

  private getAvailableInventory(marketId: string, side: OrderSide, outcome: 'YES' | 'NO'): number {
    const inv = this.inventory.get(marketId);
    if (!inv) return 0;

    const pending = this.pendingOrders.get(marketId) || 0;

    if (side === 'BUY') {
      // How many more can we buy before hitting maxInventory?
      const current = outcome === 'YES' ? inv.yesShares : inv.noShares;
      return Math.max(0, this.config.maxInventory - current - pending);
    } else {
      // How many can we sell (must own them)?
      const owned = outcome === 'YES' ? inv.yesShares : inv.noShares;
      return Math.max(0, owned - pending);
    }
  }

  // ========== FEE & SPREAD CALCULATION ==========
  private isSpreadProfitable(
    market: MarketData,
    feeRateBps: number,
    feesEnabled: boolean,
  ): boolean {
    if (!feesEnabled) return market.ask - market.bid >= 0.005;

    const feeRate = feeRateBps / 10000; // bps → decimal
    const mid = (market.ask + market.bid) / 2;

    // Polymarket fee formula: fee = C × feeRate × p × (1-p) [[25]]
    // At p=0.5, max fee per share = feeRate × 0.25
    const maxFeePerShare = feeRate * mid * (1 - mid);
    const roundTripFee = maxFeePerShare * 2;

    // Require spread > fees + buffer (minSpreadBps in dollars)
    const minProfitableSpread = roundTripFee + this.config.minSpreadBps / 10000;
    return market.ask - market.bid >= minProfitableSpread;
  }

  private calculateInventorySkew(currentShares: number, outcome: 'YES' | 'NO'): number {
    const maxInv = this.config.maxInventory;
    const ratio = Math.abs(currentShares) / maxInv;
    const maxSkew = this.config.maxSkewBps / 10000; // 5¢ = 0.05

    // Direction: long position → discourage more buys, encourage sells
    const direction = currentShares >= 0 ? 1 : -1;
    return direction * ratio * maxSkew;
  }

  private calculateDynamicConfidence(
    market: MarketData,
    spread: number,
    timeToResolutionHours: number,
  ): number {
    let confidence = 0.5;

    // Higher confidence for wider spreads (more edge)
    const spreadFactor = Math.min(1, spread / 0.1); // Normalize to 10¢ spread
    confidence += spreadFactor * 0.3;

    // Lower confidence near resolution (higher event risk)
    if (timeToResolutionHours < this.config.timeDecayThresholdHours) {
      const decayFactor = timeToResolutionHours / this.config.timeDecayThresholdHours;
      confidence *= decayFactor;
    }

    // Lower confidence in low liquidity
    const volumeFactor = Math.min(1, (market.volume24h || 0) / 5000);
    confidence *= 0.7 + volumeFactor * 0.3;

    return Math.max(this.config.minConfidence, Math.min(0.95, confidence));
  }

  // ========== SIGNAL GENERATION ==========
  async generateSignals(): Promise<Signal[]> {
    const signals: Signal[] = [];

    for (const market of this.markets.values()) {
      // ✅ Lazy-load metadata if missing
      const meta = await this.ensureMetadata(market.marketId);

      // Skip unprofitable spreads
      if (!this.isSpreadProfitable(market, meta.feeRateBps, meta.feesEnabled)) {
        continue;
      }

      const [yesTokenId, noTokenId] = market.clobTokenIds;
      const inv = this.inventory.get(market.marketId) || {
        yesShares: 0,
        noShares: 0,
        yesCostBasis: 0,
        noCostBasis: 0,
      };

      const mid = (market.ask + market.bid) / 2;
      const spread = market.ask - market.bid;
      const timeToResolution = meta.resolutionTime
        ? Math.max(0, (meta.resolutionTime - Date.now()) / 3600000)
        : 999;

      // Evaluate BOTH YES and NO
      for (const outcome of ['YES', 'NO'] as const) {
        const tokenId = outcome === 'YES' ? yesTokenId : noTokenId;
        const shares = outcome === 'YES' ? inv.yesShares : inv.noShares;
        const costBasis = outcome === 'YES' ? inv.yesCostBasis : inv.noCostBasis;

        const skew = this.calculateInventorySkew(shares, outcome);
        const confidence = this.calculateDynamicConfidence(market, spread, timeToResolution);

        // BUY signal
        const buyHeadroom = this.getAvailableInventory(market.marketId, 'BUY', outcome);
        if (buyHeadroom >= 1) {
          const edge = spread / 2 - skew;
          if (edge > 0) {
            signals.push({
              marketId: market.marketId,
              outcome,
              side: 'BUY',
              confidence,
              edge,
              metadata: { tokenId, costBasis, shares }, // ✅ Fixed typo here
            });
          }
        }

        // SELL signal
        const sellHeadroom = this.getAvailableInventory(market.marketId, 'SELL', outcome);
        if (sellHeadroom >= 1) {
          const edge = spread / 2 + skew;
          if (edge > 0) {
            signals.push({
              marketId: market.marketId,
              outcome,
              side: 'SELL',
              confidence,
              edge,
              metadata: { tokenId, costBasis, shares }, // ✅ Fixed typo here
            });
          }
        }
      }
    }

    return signals;
  }

  // ========== ORDER SIZING & PRICING ==========
  override async sizePositions(signals: Signal[]): Promise<OrderRequest[]> {
    const orders: OrderRequest[] = [];

    for (const sig of signals) {
      const market = this.markets.get(sig.marketId);
      const meta = this.metadataCache.get(sig.marketId);
      if (!market || !meta) continue;

      const inv = this.inventory.get(sig.marketId);
      const currentShares = sig.outcome === 'YES' ? inv?.yesShares : inv?.noShares;
      const size = this.calculateOrderSize(market, currentShares || 0, sig.side, sig.outcome);
      if (size < 1) continue; // Skip if size too small

      // Calculate base price with edge
      const mid = (market.ask + market.bid) / 2;
      let price = sig.side === 'BUY' ? mid - sig.edge : mid + sig.edge;

      // Competition guard: ensure orders are competitive
      if (sig.side === 'SELL') {
        price = Math.min(price, market.ask); // Must be ≤ ask to be visible
      } else {
        price = Math.max(price, market.bid); // Must be ≥ bid to be visible
      }

      // Round to market tick size
      const tick = meta.tickSize;
      const finalPrice = Math.round(price / tick) * tick;
      const roundedPrice = Number(finalPrice.toFixed(4)); // Support 4 decimals for small ticks

      orders.push({
        ...sig,
        price: roundedPrice,
        size,
        postOnly: true, // Earn maker rebates
        timeInForce: 'GTD',
        expiration: meta.resolutionTime ? meta.resolutionTime - 3600000 : undefined, // Expire 1h before resolution
      });

      // Track pending capital reservation
      const pending = this.pendingOrders.get(sig.marketId) || 0;
      this.pendingOrders.set(sig.marketId, pending + size);
    }

    return orders;
  }

  private calculateOrderSize(
    market: MarketData,
    currentShares: number,
    side: OrderSide,
    outcome: 'YES' | 'NO',
  ): number {
    const headroom =
      side === 'BUY' ? this.config.maxInventory - Math.abs(currentShares) : Math.abs(currentShares);

    // Base size constrained by headroom
    let size = Math.min(this.config.baseOrderSize, Math.floor(headroom));
    if (size < 1) return 0;

    // Time decay factor: reduce size near resolution
    const meta = this.metadataCache.get(market.marketId);
    if (meta?.resolutionTime) {
      const hoursToClose = Math.max(0, (meta.resolutionTime - Date.now()) / 3600000);
      if (hoursToClose < this.config.timeDecayThresholdHours) {
        const decayFactor = hoursToClose / this.config.timeDecayThresholdHours;
        size = Math.floor(size * decayFactor);
      }
    }

    // Liquidity factor: reduce size in illiquid markets
    const volumeFactor = Math.min(1, (market.volume24h || 0) / 2000);
    size = Math.floor(size * volumeFactor);

    return Math.max(1, size);
  }

  // ========== FILL HANDLING & P&L TRACKING ==========
  override notifyFill(order: OrderRequest, fillPrice: number, filledSize: number): void {
    const marketId = order.marketId;
    const inv = this.inventory.get(marketId) || {
      yesShares: 0,
      noShares: 0,
      yesCostBasis: 0,
      noCostBasis: 0,
    };

    const isYes = order.outcome === 'YES';
    const currentShares = isYes ? inv.yesShares : inv.noShares;
    const currentCost = isYes ? inv.yesCostBasis : inv.noCostBasis;

    if (order.side === 'BUY') {
      // Update cost basis: weighted average
      const totalCost = currentCost + fillPrice * filledSize;
      const totalShares = currentShares + filledSize;
      const newAvgCost = totalShares > 0 ? totalCost / totalShares : 0;

      if (isYes) {
        inv.yesShares = totalShares;
        inv.yesCostBasis = newAvgCost * totalShares;
      } else {
        inv.noShares = totalShares;
        inv.noCostBasis = newAvgCost * totalShares;
      }
    } else {
      // SELL: calculate realized P&L
      const avgCostPerShare = currentShares > 0 ? currentCost / currentShares : 0;
      const costBasisSold = avgCostPerShare * filledSize;
      const proceeds = fillPrice * filledSize;
      const realizedPnL = proceeds - costBasisSold;

      // Update global and market P&L
      this.marketPnL.set(marketId, (this.marketPnL.get(marketId) || 0) + realizedPnL);
      this.dailyPnL += realizedPnL;

      // Update inventory
      const newShares = currentShares - filledSize;
      const newCost = currentCost - costBasisSold;

      if (isYes) {
        inv.yesShares = Math.max(0, newShares);
        inv.yesCostBasis = Math.max(0, newCost);
      } else {
        inv.noShares = Math.max(0, newShares);
        inv.noCostBasis = Math.max(0, newCost);
      }

      logger.info(`Realized P&L: ${marketId} ${order.outcome} ${order.side}
        size=${filledSize} price=${fillPrice} pnl=${realizedPnL.toFixed(4)} USDC`);
    }

    this.inventory.set(marketId, inv);

    // Update pending orders tracking
    const pending = this.pendingOrders.get(marketId) || 0;
    this.pendingOrders.set(marketId, Math.max(0, pending - filledSize));

    // Circuit breaker check
    this.checkCircuitBreakers(marketId);

    logger.debug(
      `Inventory updated: ${marketId} ${order.outcome}=${isYes ? inv.yesShares : inv.noShares}`,
    );
  }

  private checkCircuitBreakers(marketId: string): void {
    const marketPnL = this.marketPnL.get(marketId) || 0;

    // Per-market stop loss
    if (marketPnL < -this.config.maxLossPerMarket) {
      logger.error(
        `🚨 CIRCUIT BREAKER: ${marketId} P&L=${marketPnL.toFixed(2)} < -${this.config.maxLossPerMarket}`,
      );
      this.cancelAllOrdersForMarket(marketId);
      return;
    }

    // Global daily loss limit
    if (this.dailyPnL < -this.config.dailyLossLimit) {
      logger.error(
        `🚨 GLOBAL CIRCUIT BREAKER: Daily P&L=${this.dailyPnL.toFixed(2)} < -${this.config.dailyLossLimit}`,
      );
      this.cancelAllOrders();
      return;
    }
  }

  private async cancelAllOrdersForMarket(marketId: string): Promise<void> {
    try {
      await this.client.cancelOrders({ marketId });
      this.pendingOrders.delete(marketId);
      logger.info(`Cancelled all orders for ${marketId}`);
    } catch (e) {
      logger.error(`Failed to cancel orders for ${marketId}: ${e.message}`);
    }
  }

  private async cancelAllOrders(): Promise<void> {
    try {
      await this.client.cancelAllOrders();
      this.pendingOrders.clear();
      logger.info('Cancelled all orders globally');
    } catch (e) {
      logger.error(`Failed to cancel all orders: ${e.message}`);
    }
  }

  // ========== UTILITIES ==========
  private getHoursToResolution(marketId: string): number {
    const meta = this.metadataCache.get(marketId);
    if (!meta?.resolutionTime) return 999;
    return Math.max(0, (meta.resolutionTime - Date.now()) / 3600000);
  }

  // Reset daily P&L at UTC midnight (call from scheduler)
  resetDailyMetrics(): void {
    this.dailyPnL = 0;
    logger.info('Daily P&L reset');
  }

  // Get strategy health metrics for monitoring
  getMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {
      dailyPnL: this.dailyPnL,
      activeMarkets: this.markets.size,
      pendingOrders: Array.from(this.pendingOrders.entries()),
      inventory: {},
    };

    for (const [marketId, inv] of this.inventory.entries()) {
      metrics.inventory[marketId] = {
        yesShares: inv.yesShares,
        noShares: inv.noShares,
        yesAvgCost: inv.yesShares > 0 ? inv.yesCostBasis / inv.yesShares : 0,
        noAvgCost: inv.noShares > 0 ? inv.noCostBasis / inv.noShares : 0,
        marketPnL: this.marketPnL.get(marketId) || 0,
      };
    }

    return metrics;
  }
}
