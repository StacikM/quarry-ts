import { logger } from "./logger";

/** When each kind of warning was last printed, and how many were held back since. */
const printed = new Map<string, { at: number; held: number }>();

/**
 * A warning that can happen many times a second (a slow packet, a slow plugin) must not flood the console:
 * the same `key` is printed at most once per `everyMs`, and the next line says how many were skipped.
 */
export function warnSlow(key: string, message: string, everyMs = 30_000, now: number = Date.now()): void {
  const before = printed.get(key);
  if (before && now - before.at < everyMs) {
    before.held++;
    return;
  }
  const held = before?.held ?? 0;
  printed.set(key, { at: now, held: 0 });
  logger.warn(held > 0 ? `${message} (${held} more like it since the last line)` : message);
}

/** Forgets everything (for tests). */
export function resetSlowLog(): void {
  printed.clear();
}
