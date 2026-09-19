import { logger } from '../reporting/logs';

/**
 * Retry an IDEMPOTENT exchange call with exponential backoff.
 *
 * Deliberately not used for order placement.  A POST that times out may
 * still have landed, so retrying it can double-post — the correct recovery
 * for a failed order is the next quote cycle plus reconciliation, not a
 * blind retry.  Reads and cancels are safe to repeat.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(
        { label, attempt, attempts, delay, error: err instanceof Error ? err.message : String(err) },
        `${label} failed — retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  logger.error({ label, attempts, error: message }, `${label} failed after ${attempts} attempts`);
  throw lastError;
}
