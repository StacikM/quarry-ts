import type { Socket } from "node:net";
import { config } from "../config";
import { normalizeIp } from "../util/ip";
import { logger } from "../util/logger";

/**
 * Protection against the noise every public Minecraft port gets: bots that open a connection, send half a
 * handshake and leave, and the odd flood of idle sockets.
 */

/** Open connections one address may have at once. Real players need one each, so this is generous. */
export const MAX_CONNECTIONS_PER_IP = 20;

/** How often the bad connections are summed up in the console. */
export const JUNK_REPORT_MS = 60 * 60 * 1000;

const open = new Map<string, number>();

/**
 * Call for every new socket. Returns a function to call when it closes, or null when this address has too many
 * connections open (the caller drops the socket). Behind a proxy every player shares the proxy's address, so
 * nothing is limited there: the port should only be reachable by the proxy.
 */
export function admit(socket: Socket): (() => void) | null {
  if (config.velocity.enabled) return () => {};
  const ip = normalizeIp(socket.remoteAddress ?? "");
  const count = open.get(ip) ?? 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return null;
  open.set(ip, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(ip) ?? 1) - 1;
    if (left <= 0) open.delete(ip);
    else open.set(ip, left);
  };
}

let junkAddresses = new Set<string>();
let junkCount = 0;
let junkReasons = new Map<string, number>();
let junkTimer: NodeJS.Timeout | null = null;

/**
 * A connection that sent nonsense before it even said what it wanted (a port scanner, usually).
 * They are not logged one by one: there is one line an hour with the totals.
 */
export function recordJunk(address: string, reason: string): void {
  junkCount++;
  junkAddresses.add(address.replace(/:\d+$/, ""));
  junkReasons.set(reason, (junkReasons.get(reason) ?? 0) + 1);
  if (!junkTimer) {
    junkTimer = setTimeout(reportJunk, JUNK_REPORT_MS);
    junkTimer.unref();
  }
}

/** Prints the summary now (and starts counting again). */
export function reportJunk(): void {
  if (junkTimer) clearTimeout(junkTimer);
  junkTimer = null;
  if (junkCount === 0) return;
  const reasons = [...junkReasons].map(([reason, times]) => `${reason} x${times}`).join(", ");
  logger.info(`Ignored ${junkCount} junk connection(s) from ${junkAddresses.size} address(es), probably port scanners (${reasons})`);
  junkCount = 0;
  junkAddresses = new Set();
  junkReasons = new Map();
}
