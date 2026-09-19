import { OrderRequest, WalletState } from '../types';
import { KillSwitch } from './kill_switch';
import { consoleLog } from '../reporting/console_log';
import { logger } from '../reporting/logs';
import {
  RiskStateStore,
  newRiskState,
  rollDay,
  dailyPnl,
  markToMarket,
  drawdownPct,
} from './risk_state';

/** Resolves the current mark for a position, or undefined if unknown. */
export type MarkPriceSource = (marketId: string, outcome: 'YES' | 'NO') => number | undefined;

/** Polymarket's minimum order value. Override only if the venue changes it. */
const MIN_ORDER_NOTIONAL_USD = Number(process.env.MIN_ORDER_NOTIONAL_USD ?? 1);

export class RiskEngine {
  private readonly killSwitch: KillSwitch;

  /** Rolling order timestamps per wallet for rate limiting */
  private orderTimestamps = new Map<string, number[]>();

  /** Cancel counts per wallet (rolling window) */
  private cancelCounts = new Map<string, number[]>();

  /** Total MLE (max loss at resolution) per wallet */
  private walletMle = new Map<string, number>();

  /** Day anchors and high-water marks, persisted across restarts. */
  private readonly store: RiskStateStore;

  /** Live marks. Until set, drawdown falls back to cost basis and says so. */
  private markPrice: MarkPriceSource = () => undefined;

  constructor(killSwitch: KillSwitch, store = new RiskStateStore()) {
    this.killSwitch = killSwitch;
    this.store = store;
  }

  setMarkPriceSource(source: MarkPriceSource): void {
    this.markPrice = source;
  }

  check(order: OrderRequest, wallet: WalletState): { ok: boolean; reason?: string } {
    if (this.killSwitch.isActive()) {
      consoleLog.error('RISK', `KILL SWITCH active — all orders blocked [${order.walletId}]`, {
        walletId: order.walletId,
      });
      return { ok: false, reason: 'Global kill switch active' };
    }

    /* ── Minimum notional ──
       Polymarket rejects orders under ~$1. Sizing formulas that scale off
       capital silently emit 1-share (sub-$1) orders at small capital, which
       the exchange then refuses. Fail here, visibly, instead. */
    const notional = order.price * Math.abs(order.size);
    if (notional < MIN_ORDER_NOTIONAL_USD) {
      return {
        ok: false,
        reason: `Order notional $${notional.toFixed(2)} below exchange minimum $${MIN_ORDER_NOTIONAL_USD.toFixed(2)}`,
      };
    }

    /* ── Balance check: prevent spending more than available ── */
    if (order.side === 'BUY') {
      const orderCost = order.price * order.size;
      if (orderCost > wallet.availableBalance) {
        return {
          ok: false,
          reason: `Insufficient balance: need $${orderCost.toFixed(2)}, have $${wallet.availableBalance.toFixed(2)}`,
        };
      }
    }

    const absSize = Math.abs(order.size);
    if (absSize > wallet.riskLimits.maxPositionSize) {
      return { ok: false, reason: 'Max position size exceeded' };
    }

    if (wallet.openPositions.length >= wallet.riskLimits.maxOpenTrades) {
      return { ok: false, reason: 'Max open trades exceeded' };
    }

    /* ── Mark to market: the basis for both daily PnL and drawdown ── */
    const marked = markToMarket(wallet.openPositions, this.markPrice);
    const equity = wallet.capitalAllocated + wallet.realizedPnl + marked.unrealizedPnl;

    /* ── Daily loss, anchored to the start of the UTC day ── */
    let riskState = this.store.get(wallet.walletId);
    if (!riskState) {
      // First sight of this wallet: today starts here.
      riskState = newRiskState(wallet.realizedPnl, equity);
    }
    riskState = rollDay(riskState, wallet.realizedPnl);
    if (equity > riskState.peakEquity) {
      riskState = { ...riskState, peakEquity: equity };
    }
    this.store.set(wallet.walletId, riskState);

    const todayPnl = dailyPnl(riskState, wallet.realizedPnl);
    if (todayPnl <= -wallet.riskLimits.maxDailyLoss) {
      const reason = `Max daily loss breached on ${wallet.walletId}: $${todayPnl.toFixed(2)} today (limit $${wallet.riskLimits.maxDailyLoss})`;
      // ponytail: trips the GLOBAL switch. Right with one wallet, and the
      // point of a daily loss limit is that everything stops and resting
      // orders come off. Scope it per wallet if you ever run several.
      this.killSwitch.activate(reason);
      return { ok: false, reason };
    }

    /* ── Drawdown: peak-to-trough on mark-to-market equity ── */
    const drawdown = drawdownPct(riskState.peakEquity, equity);
    if (drawdown > wallet.riskLimits.maxDrawdown) {
      if (marked.unpriced > 0) {
        logger.warn(
          { walletId: wallet.walletId, unpriced: marked.unpriced },
          'Drawdown computed with unpriced positions valued at cost — figure understates risk',
        );
      }
      return {
        ok: false,
        reason: `Drawdown ${(drawdown * 100).toFixed(1)}% from peak $${riskState.peakEquity.toFixed(2)} exceeds limit ${(wallet.riskLimits.maxDrawdown * 100).toFixed(1)}%`,
      };
    }

    /* ── Per-market MLE check ── */
    const orderCost = order.price * order.size;
    const existingExposure = wallet.openPositions
      .filter((p) => p.marketId === order.marketId)
      .reduce((s, p) => s + Math.abs(p.avgPrice * p.size), 0);
    if (existingExposure + orderCost > wallet.riskLimits.maxExposurePerMarket) {
      return { ok: false, reason: 'Max exposure per market exceeded' };
    }

    /* ── Rate limiting: max orders per minute per wallet ── */
    const rateLimit = wallet.mode === 'PAPER' ? 120 : 120;
    const now = Date.now();
    const stamps = this.orderTimestamps.get(wallet.walletId) ?? [];
    const recentStamps = stamps.filter((t) => now - t < 60_000);
    if (recentStamps.length >= rateLimit) {
      return { ok: false, reason: `Order rate limit (${rateLimit}/min) exceeded` };
    }
    recentStamps.push(now);
    this.orderTimestamps.set(wallet.walletId, recentStamps);

    return { ok: true };
  }

  /** Record a cancel event for rate tracking */
  recordCancel(walletId: string): void {
    const now = Date.now();
    const cancels = this.cancelCounts.get(walletId) ?? [];
    cancels.push(now);
    this.cancelCounts.set(
      walletId,
      cancels.filter((t) => now - t < 300_000),
    );
  }

  /** Get the cancel rate over the last 5 minutes */
  getCancelRate(walletId: string): number {
    const now = Date.now();
    const cancels = (this.cancelCounts.get(walletId) ?? []).filter((t) => now - t < 300_000);
    const orders = (this.orderTimestamps.get(walletId) ?? []).filter((t) => now - t < 300_000);
    if (orders.length === 0) return 0;
    return cancels.length / orders.length;
  }

  /** Clean up tracking data for a removed wallet */
  removeWallet(walletId: string): void {
    this.orderTimestamps.delete(walletId);
    this.cancelCounts.delete(walletId);
    this.walletMle.delete(walletId);
  }
}
