import { logger } from '../reporting/logs';

export type TickHandler = () => Promise<void> | void;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private isTicking = false;
  private readonly intervalMs: number;

  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
  }

  start(handler: TickHandler): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      // setInterval does not wait. A tick slower than the interval would
      // otherwise run concurrently with the next one — same strategy, same
      // markets, duplicate orders, because cooldowns only arm after the
      // order returns.
      if (this.isTicking) {
        logger.warn({ intervalMs: this.intervalMs }, 'Tick still running — skipping this interval');
        return;
      }
      this.isTicking = true;
      try {
        await handler();
      } catch (error) {
        logger.error({ error }, 'Scheduler tick failed');
      } finally {
        this.isTicking = false;
      }
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('Scheduler stopped');
    }
  }
}
