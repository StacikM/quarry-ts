import net from "node:net";

/**
 * Makes an IP address comparable: lower case, and IPv4 addresses that arrive
 * wrapped as IPv6 ("::ffff:203.0.113.5") are unwrapped to "203.0.113.5".
 */
export function normalizeIp(address: string): string {
  const lower = address.trim().toLowerCase();
  const wrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return wrapped ? wrapped[1] : lower;
}

/** True for a valid IPv4 or IPv6 address. */
export function isIpAddress(text: string): boolean {
  return net.isIP(normalizeIp(text)) !== 0;
}
