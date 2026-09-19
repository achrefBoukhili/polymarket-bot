import { logger } from '../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Alerts.

   The dashboard is loopback-only, so nothing reaches you when
   you are not looking at it — which is exactly when a kill
   switch trip or a failed cancel matters.  Set ALERT_WEBHOOK_URL
   to any endpoint that accepts a JSON POST (Slack, Discord,
   PagerDuty, your own).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export type AlertLevel = 'critical' | 'warning';

const WEBHOOK = process.env.ALERT_WEBHOOK_URL;
const TIMEOUT_MS = 5000;

/**
 * Fire-and-forget. An alert must never throw into, or block, the trading
 * path — a broken webhook cannot be allowed to stop the bot from cancelling
 * orders.
 */
export function alert(level: AlertLevel, title: string, detail?: Record<string, unknown>): void {
  const log = level === 'critical' ? logger.error : logger.warn;
  log.call(logger, { alert: title, ...detail }, `ALERT[${level}] ${title}`);

  if (!WEBHOOK) return;

  const body = JSON.stringify({
    level,
    title,
    // Slack and Discord both render `text`/`content`; harmless elsewhere.
    text: `[${level.toUpperCase()}] ${title}`,
    content: `[${level.toUpperCase()}] ${title}`,
    detail: detail ?? {},
    at: new Date().toISOString(),
  });

  void fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Alert webhook failed');
  });
}
