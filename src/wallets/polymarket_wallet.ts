import { WalletConfig, WalletState, Position, TradeRecord, RiskLimits, FillResult } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { getClobClient, getTradingAddresses } from '../auth/clob_client_factory';
import { withRetry } from '../execution/retry';
import { Side, OrderType } from '@polymarket/clob-client';
import { AssetType, type ClobClient, type OrderResponse } from '@polymarket/clob-client';
import {
  normalizeTrade,
  rebuildPositions,
  computeAvailableBalance,
  parseUsdc,
  type RawTrade,
} from './reconciliation';

/** One side of an order: the fields that matter for accounting. */
interface OrderLeg {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

/**
 * Shares that actually matched at post time.
 *
 * makingAmount/takingAmount describe the matched portion only:
 *   BUY  — we make USDC, take shares  → matched shares = takingAmount
 *   SELL — we make shares, take USDC  → matched shares = makingAmount
 *
 * When those are absent or unparseable, fall back to the status flag:
 * 'matched' means filled, and everything else ('live', 'delayed',
 * 'unmatched') means it is resting and nothing has filled yet.
 *
 * ponytail: post-time amounts only.  A resting order that fills later is
 * invisible until trade reconciliation polls getTrades() — that is the next
 * fix, and this one exists so we stop inventing fills in the meantime.
 */
export function matchedShares(
  response: Pick<OrderResponse, 'status' | 'makingAmount' | 'takingAmount'> | undefined,
  side: 'BUY' | 'SELL',
  requestedSize: number,
): number {
  const raw = side === 'BUY' ? response?.takingAmount : response?.makingAmount;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, requestedSize);
  return String(response?.status ?? '').toLowerCase() === 'matched' ? requestedSize : 0;
}

export class PolymarketWallet {
  private static readonly MAX_TRADE_HISTORY = 10_000;
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private readonly clobApi: string;
  private displayName: string = '';
  private clobClient: ClobClient | undefined;
  /** Orders believed to be resting on the book, keyed by CLOB order id. */
  private readonly openOrders = new Map<string, OrderLeg & { status: string; postedAt: number }>();
  /** USDC held against resting BUYs, released when those orders are cancelled. */
  private reservedCollateral = 0;
  /** tokenId → the Gamma marketId/outcome we placed it under. */
  private readonly tokenMap = new Map<string, { marketId: string; outcome: 'YES' | 'NO' }>();
  /** Addresses our orders are attributed to, lowercased. */
  private ourAddresses = new Set<string>();
  private lastReconciledAt = 0;

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.displayName = config.id;
    this.clobApi = process.env.POLYMARKET_CLOB_API ?? 'https://clob.polymarket.com';
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
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

  async checkBalances(tokenId: string) {
    if (!this.clobClient) {
      this.clobClient = await getClobClient(this.clobApi);
    }
    await this.clobClient.updateBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    // 1. Check USDC.e balance and allowance (for buying)
    const collateral = await this.clobClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    console.log(`USDC Balance: ${collateral.balance}, Allowance: ${collateral.allowance}`);

    // 2. Check specific market token balance (for selling)
    // Use the specific tokenID for the "Yes" or "No" outcome
    const shares = await this.clobClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    // await this.clobClient.approveAllowance();
    console.log(`Shares Balance: ${shares.balance}, Allowance: ${shares.allowance}`);
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    tokenId?: string;
  }): Promise<FillResult> {
    /* ── Lazily initialise the CLOB client (validates env vars on first call) ── */
    if (!this.clobClient) {
      this.clobClient = await getClobClient(this.clobApi);
    }
    // await this.checkBalances(request.tokenId!);
    /* ── Resolve CLOB token ID ── */
    const tokenId = request.tokenId;
    if (!tokenId) {
      const msg =
        'tokenId is required for LIVE orders. Pass the CLOB token ID from MarketData.clobTokenIds.';
      logger.error({ walletId: this.state.walletId, marketId: request.marketId }, msg);
      consoleLog.error('ORDER', `[${this.state.walletId}] ${msg}`);
      throw new Error(msg);
    }

    this.tokenMap.set(tokenId, { marketId: request.marketId, outcome: request.outcome });

    const orderId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cost = request.price * request.size;

    logger.info(
      {
        walletId: this.state.walletId,
        orderId,
        marketId: request.marketId,
        tokenId,
        outcome: request.outcome,
        side: request.side,
        price: request.price,
        size: request.size,
        cost,
      },
      `LIVE order submitting ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${request.size}`,
    );

    /* ── Submit signed order via the official CLOB client ── */
    let response: OrderResponse;
    try {
      response = (await this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: request.price,
          side: request.side === 'BUY' ? Side.BUY : Side.SELL,
          size: request.size,
        },
        undefined, // options — ClobClient auto-resolves tickSize & negRisk
        OrderType.GTC,
      )) as OrderResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'LIVE order failed');
      consoleLog.error('ORDER', `[${this.state.walletId}] Order failed: ${msg}`);
      throw new Error(`LIVE order failed: ${msg}`);
    }

    /* ── Rejection: the CLOB reports failure via success/errorMsg ── */
    if (response?.success === false || response?.errorMsg) {
      const msg = `LIVE order rejected by Polymarket: ${response?.errorMsg || 'unknown reason'}`;
      logger.error({ walletId: this.state.walletId, orderId, response }, msg);
      consoleLog.error('ORDER', `[${this.state.walletId}] ${msg}`);
      throw new Error(msg);
    }

    const remoteOrderId = response?.orderID ?? orderId;
    const status = String(response?.status ?? '').toLowerCase();

    /* ── Accepted is not filled.  Book only what actually matched. ── */
    const filledSize = matchedShares(response, request.side, request.size);
    const restingSize = Math.max(0, request.size - filledSize);

    if (filledSize > 0) {
      this.bookFill({ ...request, size: filledSize }, remoteOrderId);
    }
    if (restingSize > 0) {
      this.bookResting({ ...request, size: restingSize }, remoteOrderId, status);
    }

    return { orderId: remoteOrderId, filledSize, restingSize };
  }

  /** Apply a genuinely matched quantity to balance, positions and PnL. */
  private bookFill(fill: OrderLeg, remoteOrderId: string): void {
    const cost = fill.price * fill.size;
    const entryPrice = this.getExistingEntryPrice(fill.marketId, fill.outcome);

    this.applyFill(fill);

    const realizedPnl =
      fill.side === 'SELL' && entryPrice > 0 ? (fill.price - entryPrice) * fill.size : 0;
    this.state.realizedPnl += realizedPnl;
    this.state.availableBalance -= cost * (fill.side === 'BUY' ? 1 : -1);

    this.trades.push({
      orderId: remoteOrderId,
      walletId: this.state.walletId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      cost,
      realizedPnl,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: Date.now(),
    });

    if (this.trades.length > PolymarketWallet.MAX_TRADE_HISTORY) {
      this.trades.splice(0, this.trades.length - PolymarketWallet.MAX_TRADE_HISTORY);
    }

    logger.info(
      {
        walletId: this.state.walletId,
        orderId: remoteOrderId,
        marketId: fill.marketId,
        side: fill.side,
        outcome: fill.outcome,
        price: fill.price,
        size: fill.size,
        realizedPnl,
        balance: this.state.availableBalance,
      },
      `LIVE order MATCHED ${fill.side} ${fill.outcome} market=${fill.marketId} price=${fill.price} size=${fill.size}`,
    );

    consoleLog.success(
      'FILL',
      `[${this.state.walletId}] ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} → PnL $${realizedPnl.toFixed(2)} | Bal $${this.state.availableBalance.toFixed(2)}`,
      {
        walletId: this.state.walletId,
        strategy: this.state.assignedStrategy,
        orderId: remoteOrderId,
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        realizedPnl: Number(realizedPnl.toFixed(4)),
        cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
        balanceAfter: Number(this.state.availableBalance.toFixed(2)),
      },
    );
  }

  /**
   * Record a quantity left resting on the book.  No position, no PnL, no
   * trade record — none of that has happened yet.
   *
   * A resting BUY does commit collateral, so reserve it against the balance:
   * otherwise the risk engine sees the same dollar as free on every
   * subsequent quote and over-commits.  Released in cancelAllOrders().
   */
  private bookResting(order: OrderLeg, remoteOrderId: string, status: string): void {
    this.openOrders.set(remoteOrderId, { ...order, status, postedAt: Date.now() });

    if (order.side === 'BUY') {
      const reserved = order.price * order.size;
      this.reservedCollateral += reserved;
      this.state.availableBalance -= reserved;
    }

    logger.info(
      {
        walletId: this.state.walletId,
        orderId: remoteOrderId,
        marketId: order.marketId,
        side: order.side,
        outcome: order.outcome,
        price: order.price,
        size: order.size,
        status,
        openOrders: this.openOrders.size,
      },
      `LIVE order RESTING ${order.side} ${order.outcome} market=${order.marketId} price=${order.price} size=${order.size} status=${status}`,
    );

    consoleLog.info(
      'ORDER',
      `[${this.state.walletId}] RESTING ${order.side} ${order.outcome} ×${order.size} @ $${order.price} (${status})`,
      {
        walletId: this.state.walletId,
        strategy: this.state.assignedStrategy,
        orderId: remoteOrderId,
        marketId: order.marketId,
        status,
        openOrders: this.openOrders.size,
      },
    );
  }

  /**
   * Overwrite local state with what the exchange says is true.
   *
   * This is the authority.  placeOrder() keeps an optimistic view between
   * cycles so strategies get immediate feedback, and every cycle this
   * replaces it: positions and realised PnL rebuilt from our actual fills,
   * resting orders from the live book, cash from the real USDC balance.
   *
   * Rebuilding from scratch (rather than applying deltas) is what makes
   * repeated reconciliation safe — a trade counted twice is not possible.
   *
   * ponytail: fetches the full trade history each cycle.  Fine at this size;
   * if it gets slow, page with `after` from the newest fill we have already
   * seen and merge instead of replacing.
   */
  async reconcile(): Promise<void> {
    if (!this.clobClient) {
      this.clobClient = await getClobClient(this.clobApi);
    }
    const client = this.clobClient;

    await this.resolveOurAddresses();

    /* ── 1. Fills → positions and realised PnL ── */
    const trades = (await withRetry('getTrades', () => client.getTrades())) as unknown as RawTrade[];
    const fills = trades.flatMap((t) => normalizeTrade(t, this.ourAddresses));
    const { positions, realizedPnl, grossRealizedPnl, fees } = rebuildPositions(fills);

    this.state.openPositions = positions.map((p) => {
      const mapped = this.tokenMap.get(p.tokenId);
      return {
        // Fall back to the condition id when we have not quoted this token in
        // this process — the position is still real and still counts for risk.
        marketId: mapped?.marketId ?? p.conditionId,
        outcome: mapped?.outcome ?? (p.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES'),
        size: p.size,
        avgPrice: p.avgPrice,
        realizedPnl: p.realizedPnl,
      };
    });
    this.state.realizedPnl = realizedPnl;

    /* ── 2. Resting orders → reserved collateral ── */
    const openOrders = await withRetry('getOpenOrders', () => client.getOpenOrders());
    this.openOrders.clear();
    this.reservedCollateral = 0;
    for (const o of openOrders) {
      const remaining = Number(o.original_size) - Number(o.size_matched);
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      const side = String(o.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const price = Number(o.price);
      const mapped = this.tokenMap.get(o.asset_id);
      this.openOrders.set(o.id, {
        marketId: mapped?.marketId ?? o.market,
        outcome: mapped?.outcome ?? (String(o.outcome).toUpperCase() === 'NO' ? 'NO' : 'YES'),
        side,
        price,
        size: remaining,
        status: o.status,
        postedAt: o.created_at * 1000,
      });
      if (side === 'BUY') this.reservedCollateral += price * remaining;
    }

    /* ── 3. Real cash ── */
    await withRetry('updateBalanceAllowance', () =>
      client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    );
    const collateral = await withRetry('getBalanceAllowance', () =>
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    );
    const chainCash = parseUsdc(collateral?.balance);

    /* ── 3b. Drop positions the chain no longer backs ──
       A resolved market's shares are redeemed on-chain, which is not a CLOB
       trade, so rebuildPositions() would carry them forever. The conditional
       token balance is the authority on whether we still hold anything. */
    await this.dropRedeemedPositions(client, positions);

    const positionCost = this.state.openPositions.reduce((sum, p) => sum + p.avgPrice * p.size, 0);
    this.state.availableBalance = computeAvailableBalance({
      chainCash,
      capitalAllocated: this.state.capitalAllocated,
      positionCost,
      reservedCollateral: this.reservedCollateral,
    });

    this.lastReconciledAt = Date.now();

    logger.info(
      {
        walletId: this.state.walletId,
        chainCash,
        availableBalance: this.state.availableBalance,
        reservedCollateral: this.reservedCollateral,
        positions: this.state.openPositions.length,
        positionCost,
        openOrders: this.openOrders.size,
        realizedPnl,
        grossRealizedPnl,
        fees,
        fills: fills.length,
      },
      'Reconciled with exchange',
    );

    consoleLog.info(
      'WALLET',
      `[${this.state.walletId}] Reconciled — cash $${chainCash.toFixed(2)}, available $${this.state.availableBalance.toFixed(2)}, ${this.state.openPositions.length} position(s), ${this.openOrders.size} resting, fees $${fees.toFixed(4)}`,
      {
        walletId: this.state.walletId,
        chainCash: Number(chainCash.toFixed(4)),
        availableBalance: Number(this.state.availableBalance.toFixed(4)),
        reservedCollateral: Number(this.reservedCollateral.toFixed(4)),
        realizedPnl: Number(realizedPnl.toFixed(4)),
        fees: Number(fees.toFixed(4)),
      },
    );
  }

  /** Positions checked against the chain most recently, to bound API calls. */
  private static readonly MAX_BALANCE_CHECKS_PER_CYCLE = 20;

  /**
   * Remove positions whose conditional tokens we no longer hold.
   *
   * Redemption after resolution does not appear in the trade history, so a
   * settled position stays in the rebuilt book indefinitely. The payout
   * itself is already reflected in the USDC balance we read above; what is
   * NOT attributed is the realised PnL for it, and we say so rather than
   * inventing a settlement price.
   */
  private async dropRedeemedPositions(
    client: ClobClient,
    rebuilt: Array<{ tokenId: string }>,
  ): Promise<void> {
    const checks = rebuilt.slice(0, PolymarketWallet.MAX_BALANCE_CHECKS_PER_CYCLE);

    for (const [index, position] of checks.entries()) {
      try {
        const held = await withRetry('getBalanceAllowance(conditional)', () =>
          client.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: position.tokenId,
          }),
        );
        const shares = parseUsdc(held?.balance); // conditional tokens are 6dp too
        if (shares > 0.000001) continue;

        const dropped = this.state.openPositions[index];
        if (!dropped) continue;
        this.state.openPositions = this.state.openPositions.filter((p) => p !== dropped);

        logger.warn(
          {
            walletId: this.state.walletId,
            marketId: dropped.marketId,
            outcome: dropped.outcome,
            size: dropped.size,
            avgPrice: dropped.avgPrice,
          },
          'Position dropped: chain holds none of this token (redeemed or settled). Its payout is in the cash balance but is not attributed to realisedPnl.',
        );
        consoleLog.warn(
          'WALLET',
          `[${this.state.walletId}] Position gone on-chain — ${dropped.outcome} ×${dropped.size} in ${dropped.marketId.slice(0, 12)}… (redeemed/settled)`,
          { walletId: this.state.walletId, marketId: dropped.marketId },
        );
      } catch (err) {
        // A failed balance read must not delete a real position.
        logger.error(
          { walletId: this.state.walletId, tokenId: position.tokenId, err },
          'Conditional balance check failed — keeping the position',
        );
      }
    }

    if (rebuilt.length > checks.length) {
      logger.warn(
        { checked: checks.length, total: rebuilt.length },
        'More positions than the per-cycle balance-check budget; the rest are checked next cycle',
      );
    }
  }

  /**
   * Which addresses our maker orders are attributed to.  Needed to pick our
   * own fills out of a match that included other makers.
   */
  private async resolveOurAddresses(): Promise<void> {
    if (this.ourAddresses.size > 0) return;
    this.ourAddresses = await getTradingAddresses(this.clobApi);
    if (this.ourAddresses.size === 0) {
      logger.error(
        { walletId: this.state.walletId },
        'Cannot determine our own address — maker fills cannot be attributed and positions will be wrong. Set POLYMARKET_FUNDER.',
      );
    }
  }

  getLastReconciledAt(): number {
    return this.lastReconciledAt;
  }

  /**
   * Cancel this wallet's resting orders in one market.  Used for
   * cancel-replace: a quote you cannot pull is a free option you wrote.
   */
  async cancelOrdersForMarket(marketId: string): Promise<number> {
    const ids = [...this.openOrders.entries()]
      .filter(([, o]) => o.marketId === marketId)
      .map(([id]) => id);
    if (ids.length === 0) return 0;

    if (!this.clobClient) {
      this.clobClient = await getClobClient(this.clobApi);
    }
    await withRetry('cancelOrders', () => this.clobClient!.cancelOrders(ids));

    for (const id of ids) {
      const order = this.openOrders.get(id);
      if (order?.side === 'BUY') {
        const released = order.price * order.size;
        this.reservedCollateral -= released;
        this.state.availableBalance += released;
      }
      this.openOrders.delete(id);
    }

    logger.info({ walletId: this.state.walletId, marketId, cancelled: ids.length }, 'Cancelled resting orders for market');
    return ids.length;
  }

  /** Orders believed to be resting (best-effort until reconciliation lands). */
  getOpenOrders(): Array<OrderLeg & { orderId: string; status: string }> {
    return [...this.openOrders.entries()].map(([orderId, o]) => ({ orderId, ...o }));
  }

  /**
   * Cancel every resting order on the CLOB.  Called on shutdown so we never
   * leave live quotes on the book with nothing managing them.
   *
   * Initialises the client if needed: orders may be resting from a previous
   * run even when this process never placed one.
   *
   * ponytail: cancelAll() is account-wide, not per-wallet — with several LIVE
   * wallets sharing one key the first call cancels everyone's orders and the
   * rest are no-ops.  That is what we want on shutdown.  Per-wallet cancel
   * needs resting-order-ID tracking, which does not exist yet.
   */
  async cancelAllOrders(): Promise<void> {
    if (!this.clobClient) {
      this.clobClient = await getClobClient(this.clobApi);
    }
    const response = await withRetry('cancelAll', () => this.clobClient!.cancelAll());

    // Those orders no longer hold collateral — give the balance back.
    const released = this.reservedCollateral;
    this.state.availableBalance += released;
    this.reservedCollateral = 0;
    this.openOrders.clear();

    logger.info(
      { walletId: this.state.walletId, released, response },
      'Cancelled all resting CLOB orders',
    );
    consoleLog.warn('ORDER', `[${this.state.walletId}] Cancelled all resting orders`);
  }

  private getExistingEntryPrice(marketId: string, outcome: 'YES' | 'NO'): number {
    const pos = this.state.openPositions.find(
      (p) => p.marketId === marketId && p.outcome === outcome,
    );
    return pos ? pos.avgPrice : 0;
  }

  private applyFill(fill: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): void {
    const existing = this.state.openPositions.find(
      (pos) => pos.marketId === fill.marketId && pos.outcome === fill.outcome,
    );

    if (!existing) {
      if (fill.side === 'BUY') {
        this.state.openPositions.push({
          marketId: fill.marketId,
          outcome: fill.outcome,
          size: fill.size,
          avgPrice: fill.price,
          realizedPnl: 0,
        });
      }
      return;
    }

    if (fill.side === 'BUY') {
      const newSize = existing.size + fill.size;
      existing.avgPrice = (existing.avgPrice * existing.size + fill.price * fill.size) / newSize;
      existing.size = newSize;
    } else {
      existing.size -= Math.min(fill.size, existing.size);
      if (existing.size <= 0) {
        existing.size = 0;
        existing.avgPrice = 0;
      }
    }

    this.state.openPositions = this.state.openPositions.filter((p) => p.size > 0);
  }
}
