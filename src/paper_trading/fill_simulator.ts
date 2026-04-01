import { SlippageModel } from './slippage_model';
import { consoleLog } from '../reporting/console_log';

export class FillSimulator {
  private readonly slippage = new SlippageModel();

  simulate(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): {
    orderId: string;
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    timestamp: number;
  } {
    const adjusted = this.slippage.apply(request.price, request.size, request.side);
    const fill = {
      orderId: `paper-${Date.now()}`,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: Number(adjusted.toFixed(4)),
      size: request.size,
      timestamp: Date.now(),
    };

    const slippageBps = Math.abs(fill.price - request.price) / request.price * 10000;
    consoleLog.info('FILL', `Paper fill: ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} (slip ${slippageBps.toFixed(1)} bps) — ${fill.orderId}`, {
      orderId: fill.orderId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      requestedPrice: request.price,
      filledPrice: fill.price,
      size: fill.size,
      slippageBps: Number(slippageBps.toFixed(1)),
      cost: Number((fill.price * fill.size).toFixed(4)),
    });

    return fill;
  }
}
