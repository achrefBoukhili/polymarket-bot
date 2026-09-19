import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { alert } from '../reporting/alerts';

/**
 * Global stop.  When active the RiskEngine rejects every order.
 *
 * Activation also fires the registered hooks — cli.ts uses that to pull
 * resting orders off the book, because a stop that leaves live quotes
 * working is not a stop.
 */
export class KillSwitch {
  private enabled = false;
  private reason?: string;
  private activatedAt?: number;
  private readonly hooks: Array<(reason: string) => void | Promise<void>> = [];

  /** Run something when the switch trips (e.g. cancel all resting orders). */
  onActivate(hook: (reason: string) => void | Promise<void>): void {
    this.hooks.push(hook);
  }

  activate(reason = 'manual'): void {
    if (this.enabled) return; // already tripped — do not re-fire the hooks
    this.enabled = true;
    this.reason = reason;
    this.activatedAt = Date.now();

    logger.error({ reason }, 'KILL SWITCH ACTIVATED — all orders blocked');
    consoleLog.error('RISK', `KILL SWITCH ACTIVATED — ${reason}`, { reason });
    alert('critical', 'Kill switch activated — trading halted', { reason });

    for (const hook of this.hooks) {
      try {
        void hook(reason);
      } catch (err) {
        logger.error({ err }, 'Kill switch hook failed');
      }
    }
  }

  deactivate(): void {
    if (!this.enabled) return;
    this.enabled = false;
    logger.warn({ previousReason: this.reason }, 'Kill switch released — trading re-enabled');
    consoleLog.warn('RISK', 'Kill switch released — trading re-enabled');
    this.reason = undefined;
    this.activatedAt = undefined;
  }

  isActive(): boolean {
    return this.enabled;
  }

  getStatus(): { active: boolean; reason?: string; activatedAt?: number } {
    return { active: this.enabled, reason: this.reason, activatedAt: this.activatedAt };
  }
}
