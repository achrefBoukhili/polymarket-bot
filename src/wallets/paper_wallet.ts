import {
  WalletConfig, WalletState, Position, TradeRecord, RiskLimits, FillResult, MarketData,
} from '../types';
import { simulateMarketable, restingOrderFills, rejectionReason, type Book } from '../paper_trading/fill_simulator';
import {
  tradeFee, makerRebate, paperFallbackSchedule, REBATE_MIN_PAYOUT_USD, type FeeSchedule,
} from '../execution/fees';
import { utcDayKey } from '../risk/risk_state';
import { AttributionTracker, type Attribution } from '../reporting/attribution';
import { significance, perTradePnl, type Significance } from '../reporting/statistics';
import { PnlTracker } from '../paper_trading/pnl_tracker';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

export class PaperWallet {
  private static readonly MAX_TRADE_HISTORY = 10_000;
  /** Simulated time between submitting an order and it reaching the book. */
  private static readonly LATENCY_MS = Number(process.env.PAPER_LATENCY_MS ?? 250);
  private state: WalletState;
  /** Orders sitting on the simulated book, keyed by order id. */
  private readonly resting = new Map<
    string,
    {
      orderId: string; marketId: string; outcome: 'YES' | 'NO'; side: 'BUY' | 'SELL';
      price: number; size: number; postedAt: number;
      /** Mid when the quote was posted — the reference for spread capture. */
      midAtPost: number;
    }
  >();
  /** Cash committed to resting BUYs. */
  private reserved = 0;
  /** Cumulative simulated fees, so the drag is visible rather than implied. */
  private feesPaid = 0;
  /** Maker rebate earned but not yet paid out (they settle daily). */
  private rebateAccrued = 0;
  /** Lifetime rebate actually credited. */
  private rebatesPaid = 0;
  /** UTC day the current accrual belongs to. */
  private rebateDay = utcDayKey();
  /** Where the PnL came from, not just how much. */
  private readonly attribution = new AttributionTracker();
  /** Current book per market, supplied by the engine. */
  private marketSource: (marketId: string) => Book | undefined = () => undefined;
  /** Fee schedule per market, from Gamma. */
  private feeSource: (marketId: string) => FeeSchedule | undefined = () => undefined;
  private readonly pnlTracker = new PnlTracker();
  private readonly trades: TradeRecord[] = [];
  private displayName: string = '';

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.displayName = config.id;
    this.state = {
      walletId: config.id,
      mode: 'PAPER',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
  }

  /** Wire the live book in. Without it nothing is marketable and nothing fills. */
  setMarketSource(source: (marketId: string) => Book | undefined): void {
    this.marketSource = source;
  }

  /** Per-market fee schedule. Without it, fills fall back to PAPER_FEE_RATE. */
  setFeeSource(source: (marketId: string) => FeeSchedule | undefined): void {
    this.feeSource = source;
  }

  private book(marketId: string): Book | undefined {
    return this.marketSource(marketId);
  }

  /** Restore a persisted snapshot. LIVE wallets reconcile instead. */
  restore(state: Partial<WalletState>, trades: TradeRecord[]): void {
    if (state.availableBalance !== undefined) this.state.availableBalance = state.availableBalance;
    if (state.realizedPnl !== undefined) this.state.realizedPnl = state.realizedPnl;
    if (state.openPositions) this.state.openPositions = [...state.openPositions];
    this.trades.push(...trades);
    logger.info(
      { walletId: this.state.walletId, positions: this.state.openPositions.length, trades: trades.length },
      'Paper wallet restored from disk',
    );
  }

  getFeesPaid(): number {
    return this.feesPaid;
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  getDisplayName(): string {
    return this.displayName;
  }

  setDisplayName(name: string): void {
    this.displayName = name.trim() || this.state.walletId;
  }

  updateRiskLimits(limits: Partial<RiskLimits>): void {
    if (limits.maxPositionSize !== undefined)
      this.state.riskLimits.maxPositionSize = limits.maxPositionSize;
    if (limits.maxExposurePerMarket !== undefined)
      this.state.riskLimits.maxExposurePerMarket = limits.maxExposurePerMarket;
    if (limits.maxDailyLoss !== undefined) this.state.riskLimits.maxDailyLoss = limits.maxDailyLoss;
    if (limits.maxOpenTrades !== undefined)
      this.state.riskLimits.maxOpenTrades = limits.maxOpenTrades;
    if (limits.maxDrawdown !== undefined) this.state.riskLimits.maxDrawdown = limits.maxDrawdown;
    logger.info(
      { walletId: this.state.walletId, riskLimits: this.state.riskLimits },
      'Risk limits updated',
    );
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    tokenId?: string;
  }): Promise<FillResult> {
    const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    /* ── Submission latency ──
       A real order takes time to reach the matching engine, and the book
       moves while it flies. Awaiting here means the fill below is priced
       against whatever the book looks like AFTER the delay, not before —
       which is the point, since the feed keeps updating meanwhile. */
    if (PaperWallet.LATENCY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, PaperWallet.LATENCY_MS));
    }

    const book = this.book(request.marketId);

    // Reject what the venue would reject, rather than filling it.
    const rejection = rejectionReason(request, book);
    if (rejection) {
      consoleLog.warn(
        'ORDER',
        `[${this.state.walletId}] PAPER order rejected: ${rejection}`,
        { walletId: this.state.walletId, ...request },
      );
      throw new Error(`PAPER order rejected: ${rejection}`);
    }

    const sim = simulateMarketable(request, book);

    if (sim.filledSize > 0) {
      // We crossed the spread to get this, so we are the taker.
      this.bookFill(
        { ...request, price: sim.fillPrice, size: sim.filledSize },
        orderId,
        request.price,
        true,
      );
    }

    if (sim.restingSize > 0) {
      this.resting.set(orderId, {
        orderId,
        marketId: request.marketId,
        outcome: request.outcome,
        side: request.side,
        price: request.price,
        size: sim.restingSize,
        postedAt: Date.now(),
        midAtPost: book ? (book.bid + book.ask) / 2 : request.price,
      });
      const reserved = request.side === 'BUY' ? request.price * sim.restingSize : 0;
      this.reserved += reserved;
      this.state.availableBalance -= reserved;

      consoleLog.debug(
        'ORDER',
        `[${this.state.walletId}] PAPER resting ${request.side} ${request.outcome} ×${sim.restingSize} @ $${request.price} (book ${book ? `${book.bid}/${book.ask}` : 'unknown'})`,
        { walletId: this.state.walletId, orderId, marketId: request.marketId, resting: this.resting.size },
      );
    }

    return { orderId, filledSize: sim.filledSize, restingSize: sim.restingSize };
  }

  /**
   * Work the resting book against a fresh market snapshot.
   *
   * Called by the engine on every market update.  A resting order fills when
   * the market comes to it — which for a maker means the market moved against
   * them.  Without this, paper market making never fills at all.
   */
  onMarketUpdate(data: MarketData): void {
    // Always observe the mid — markouts resolve on the clock, not on fills.
    this.attribution.observeMid(data.marketId, (data.bid + data.ask) / 2);

    if (this.resting.size === 0) return;
    const book = { bid: data.bid, ask: data.ask, liquidity: data.liquidity };

    for (const [orderId, order] of [...this.resting]) {
      if (order.marketId !== data.marketId) continue;
      if (!restingOrderFills(order, book)) continue;

      this.resting.delete(orderId);
      if (order.side === 'BUY') {
        const released = order.price * order.size;
        this.reserved -= released;
        this.state.availableBalance += released; // bookFill charges the real cost
      }
      // Filled at our own resting price — we were the maker, they crossed,
      // so no fee is owed.
      this.bookFill({ ...order }, orderId, order.price, false, order.midAtPost);
    }
  }

  /** Cancel every resting paper order and release its collateral. */
  async cancelAllOrders(): Promise<void> {
    this.state.availableBalance += this.reserved;
    this.reserved = 0;
    this.resting.clear();
  }

  async cancelOrdersForMarket(marketId: string): Promise<number> {
    let cancelled = 0;
    for (const [id, order] of [...this.resting]) {
      if (order.marketId !== marketId) continue;
      if (order.side === 'BUY') {
        const released = order.price * order.size;
        this.reserved -= released;
        this.state.availableBalance += released;
      }
      this.resting.delete(id);
      cancelled++;
    }
    return cancelled;
  }

  getOpenOrders(): Array<{ orderId: string; marketId: string; side: string; price: number; size: number }> {
    return [...this.resting.values()];
  }

  /**
   * Redeem a position in a resolved market: winners pay $1 a share, losers
   * pay nothing.  Booked as a fill at the settlement price so it flows
   * through PnL and the trade log like any other close.
   */
  settle(marketId: string, outcome: 'YES' | 'NO', price: number): boolean {
    const pos = this.state.openPositions.find(
      (p) => p.marketId === marketId && p.outcome === outcome,
    );
    if (!pos || pos.size <= 0) return false;

    const size = pos.size;
    const proceeds = price * size;
    const cost = pos.avgPrice * size;

    // Cancel anything still resting in a market that no longer trades.
    void this.cancelOrdersForMarket(marketId);

    this.attribution.recordSettlement(proceeds - cost);
    this.bookFill({ marketId, outcome, side: 'SELL', price, size }, `settle-${marketId}-${outcome}`, price, false);

    logger.info(
      { walletId: this.state.walletId, marketId, outcome, price, size, proceeds, cost, pnl: proceeds - cost },
      `Settled ${outcome} ×${size} at $${price} (resolved market)`,
    );
    consoleLog.info(
      'WALLET',
      `[${this.state.walletId}] SETTLED ${outcome} ×${size} @ $${price} — market resolved, PnL $${(proceeds - cost).toFixed(2)}`,
      { walletId: this.state.walletId, marketId, outcome, price, size },
    );
    return true;
  }

  /**
   * Credit accrued maker rebates once the UTC day rolls over.
   *
   * Below the $1 minimum the balance carries forward rather than being lost,
   * which is what "minimum accrued rebate of $1 is required for a payout"
   * means — small makers accumulate until they qualify.
   */
  private payRebatesIfDue(): void {
    const today = utcDayKey();
    if (today === this.rebateDay) return;
    this.rebateDay = today;

    if (this.rebateAccrued < REBATE_MIN_PAYOUT_USD) return; // carries over

    const payout = this.rebateAccrued;
    this.rebateAccrued = 0;
    this.rebatesPaid += payout;
    this.state.availableBalance += payout;
    this.state.realizedPnl += payout;

    logger.info(
      { walletId: this.state.walletId, payout, lifetime: this.rebatesPaid },
      'Maker rebate paid',
    );
    consoleLog.success(
      'WALLET',
      `[${this.state.walletId}] Maker rebate paid $${payout.toFixed(4)} (lifetime $${this.rebatesPaid.toFixed(4)})`,
      { walletId: this.state.walletId, payout: Number(payout.toFixed(4)) },
    );
  }

  /** Where this wallet's PnL actually came from. */
  getAttribution(): Attribution {
    return this.attribution.snapshot(this.state.openPositions);
  }

  /** Whether this wallet's result is distinguishable from noise. */
  getSignificance(): Significance {
    return significance(perTradePnl(this.trades));
  }

  /** Rebate earned but not yet paid (settles daily, $1 minimum). */
  getRebateAccrued(): number {
    return this.rebateAccrued;
  }

  /** Rebate actually credited over this wallet's life. */
  getRebatesPaid(): number {
    return this.rebatesPaid;
  }

  /** Apply a fill to balance, positions, PnL and the trade log. */
  private bookFill(
    fill: { marketId: string; outcome: 'YES' | 'NO'; side: 'BUY' | 'SELL'; price: number; size: number },
    orderId: string,
    requestedPrice: number,
    isTaker: boolean,
    /**
     * Mid to measure spread capture against.
     *
     * For a taker it is the current mid — we crossed right now. For a maker
     * it must be the mid when the quote was POSTED: a resting order fills
     * precisely because the market moved through it, so the mid at fill is
     * already adverse, and using it would book adverse selection as negative
     * capture and double-count the same move.
     */
    captureMid?: number,
  ): void {
    // Capture entry price BEFORE applyFill mutates the position
    // (on full close, applyFill resets avgPrice to 0)
    const existingPos = this.state.openPositions.find(
      (p) => p.marketId === fill.marketId && p.outcome === fill.outcome,
    );
    const entryPrice = existingPos ? existingPos.avgPrice : 0;

    const position = this.applyFill(fill);
    const pnl = this.pnlTracker.recordFill(fill, position, entryPrice);

    // Takers pay, makers do not. Charging a market maker for being hit is
    // how a paper MM looks unprofitable when the real one would not be.
    const schedule = this.feeSource(fill.marketId) ?? paperFallbackSchedule();
    const fee = tradeFee(fill.price, fill.size, schedule, isTaker);
    this.feesPaid += fee;
    const rebate = makerRebate(fill.price, fill.size, schedule, isTaker);

    /* Maker rebate accrues on this fill but is NOT credited now — the real
       programme pays out daily, so crediting per fill would overstate
       available capital between payouts. */
    this.rebateAccrued += rebate;
    this.payRebatesIfDue();

    // Mid at fill time is what makes spread capture and markout computable.
    const book = this.book(fill.marketId);
    const referenceMid = captureMid ?? (book ? (book.bid + book.ask) / 2 : undefined);
    if (referenceMid !== undefined) {
      this.attribution.recordFill({
        fillId: orderId,
        marketId: fill.marketId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        mid: referenceMid,
        isTaker,
        fee,
        rebate,
        timestamp: Date.now(),
      });
    }

    this.state.realizedPnl += pnl.realized - fee;
    const cost = fill.price * fill.size * (fill.side === 'BUY' ? 1 : -1);
    this.state.availableBalance -= cost + fee;

    this.trades.push({
      orderId,
      walletId: this.state.walletId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      cost: Math.abs(cost),
      realizedPnl: pnl.realized,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: Date.now(),
    });

    if (this.trades.length > PaperWallet.MAX_TRADE_HISTORY) {
      this.trades.splice(0, this.trades.length - PaperWallet.MAX_TRADE_HISTORY);
    }

    const slipBps =
      requestedPrice > 0 ? (Math.abs(fill.price - requestedPrice) / requestedPrice) * 10000 : 0;

    logger.info(
      { walletId: this.state.walletId, marketId: fill.marketId, price: fill.price, size: fill.size },
      `${this.state.walletId} PAPER fill ${fill.side} ${fill.outcome} market=${fill.marketId} price=${fill.price} size=${fill.size}`,
    );

    consoleLog.success(
      'FILL',
      `[${this.state.walletId}] ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} (slip ${slipBps.toFixed(1)} bps) → PnL $${pnl.realized.toFixed(2)} | Bal $${this.state.availableBalance.toFixed(2)}`,
      {
        walletId: this.state.walletId,
        strategy: this.state.assignedStrategy,
        orderId,
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        requestedPrice,
        price: fill.price,
        size: fill.size,
        slippageBps: Number(slipBps.toFixed(1)),
        fee: Number(fee.toFixed(4)),
        feesPaid: Number(this.feesPaid.toFixed(4)),
        rebateAccrued: Number(this.rebateAccrued.toFixed(4)),
        realizedPnl: Number((pnl.realized - fee).toFixed(4)),
        cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
        balanceAfter: Number(this.state.availableBalance.toFixed(2)),
        openPositions: this.state.openPositions.length,
      },
    );
  }

  private applyFill(fill: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Position {
    const existing = this.state.openPositions.find(
      (pos) => pos.marketId === fill.marketId && pos.outcome === fill.outcome,
    );
    if (!existing) {
      if (fill.side === 'SELL') {
        // Selling without a position — return a phantom position, don't add to state
        return {
          marketId: fill.marketId,
          outcome: fill.outcome,
          size: 0,
          avgPrice: fill.price,
          realizedPnl: 0,
        };
      }
      const position: Position = {
        marketId: fill.marketId,
        outcome: fill.outcome,
        size: fill.size,
        avgPrice: fill.price,
        realizedPnl: 0,
      };
      this.state.openPositions.push(position);
      return position;
    }

    if (fill.side === 'BUY') {
      // Adding to position — update cost basis with weighted average
      const newSize = existing.size + fill.size;
      existing.avgPrice = (existing.avgPrice * existing.size + fill.price * fill.size) / newSize;
      existing.size = newSize;
    } else {
      // Reducing / closing position — keep avgPrice (cost basis) unchanged
      const reduceQty = Math.min(fill.size, existing.size);
      existing.size -= reduceQty;
      // If fully closed, reset avgPrice
      if (existing.size <= 0) {
        existing.size = 0;
        existing.avgPrice = 0;
      }
      // avgPrice stays the same for partial closes — this is critical for
      // correct realized PnL: (fillPrice − entryPrice) × qty
    }

    // Clean up zero-size positions
    this.state.openPositions = this.state.openPositions.filter((p) => p.size > 0);

    return existing;
  }
}
