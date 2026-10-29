/**
 * A tiny logger that prefixes every line with the time and a level.
 */
function timestamp(): string {
  return new Date().toTimeString().slice(0, 8); // "HH:MM:SS"
}

/** Turns anything that was thrown (even null or a string) into printable text. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export const logger = {
  info(message: string): void {
    console.log(`[${timestamp()} INFO] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[${timestamp()} WARN] ${message}`);
  },
  error(message: string): void {
    console.error(`[${timestamp()} ERROR] ${message}`);
  },
};
