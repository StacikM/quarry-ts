import fs from "node:fs";
import path from "node:path";
import { VALID_USERNAME } from "../util/username";
import { isIpAddress, normalizeIp } from "../util/ip";
import { writeFileAtomic } from "../util/atomicWrite";
import { logger } from "../util/logger";

/** Who is banned and why. Saved to bans.json, which is kept out of git. */

export interface BanRecord {
  reason: string;
  /** Who issued the ban: a player name, or "Console". */
  by: string;
  /** When, as an ISO date like 2026-10-30T12:00:00.000Z. */
  date: string;
}
export interface NameBan extends BanRecord {
  name: string;
}
export interface IpBan extends BanRecord {
  ip: string;
}

export type BanResult = "banned" | "already" | "invalid";
export type UnbanResult = "unbanned" | "not-banned";

const MAX_REASON_LENGTH = 100;

/** Cleans up a reason typed by a player or operator: no colour codes or control characters, not too long. */
export function cleanReason(text: string, fallback: string): string {
  const cleaned = text.replace(/[§\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_REASON_LENGTH);
  return cleaned || fallback;
}

/** The message a banned person sees when the server turns them away. */
export function banMessage(record: BanRecord): string {
  return `You are banned from this server.\nReason: ${record.reason}`;
}

export class BanList {
  private names = new Map<string, NameBan>(); // key: the name in lower case
  private ips = new Map<string, IpBan>(); // key: the normalised address

  /**
   * Loads bans.json (in the folder the server runs from).
   *
   * - No file: no bans yet.
   * - File that cannot be READ (disk error): throws, so the server does not
   *   start and quietly forget everyone's bans.
   * - File whose contents are not valid JSON: set aside as bans.json.corrupt
   *   with a loud error, and we start with no bans.
   * - Individual entries that are malformed are skipped and counted.
   */
  constructor(private readonly file: string = path.resolve("bans.json")) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot read ${file}: ${(err as Error).message}. Refusing to start without the ban list.`);
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      this.setAside(file, `it is not valid JSON (${(err as Error).message})`);
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      this.setAside(file, "it is not a JSON object");
      return;
    }
    this.readEntries(data as { names?: unknown; ips?: unknown });
  }

  private setAside(file: string, why: string): void {
    const aside = `${file}.corrupt`;
    try {
      fs.renameSync(file, aside);
    } catch {
      // If even renaming fails, we still carry on.
    }
    logger.error(`${file} was damaged (${why}). It was moved to ${aside} and NO bans are active until you fix it!`);
  }

  private readEntries(data: { names?: unknown; ips?: unknown }): void {
    let skipped = 0;
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
    const baseOf = (entry: Record<string, unknown>): BanRecord | null =>
      typeof entry.reason === "string" && typeof entry.by === "string" && typeof entry.date === "string"
        ? { reason: entry.reason, by: entry.by, date: entry.date }
        : null;

    for (const entry of Array.isArray(data.names) ? data.names : []) {
      const base = isRecord(entry) ? baseOf(entry) : null;
      if (base && isRecord(entry) && typeof entry.name === "string" && VALID_USERNAME.test(entry.name)) {
        this.names.set(entry.name.toLowerCase(), { ...base, name: entry.name });
      } else skipped++;
    }
    for (const entry of Array.isArray(data.ips) ? data.ips : []) {
      const base = isRecord(entry) ? baseOf(entry) : null;
      if (base && isRecord(entry) && typeof entry.ip === "string" && isIpAddress(entry.ip)) {
        const ip = normalizeIp(entry.ip);
        this.ips.set(ip, { ...base, ip });
      } else skipped++;
    }
    if (skipped > 0) logger.warn(`${this.file}: skipped ${skipped} malformed ban entr${skipped === 1 ? "y" : "ies"}.`);
  }

  /** Writes the new lists to disk first. Only if that works do we change the lists in memory. */
  private commit(names: Map<string, NameBan>, ips: Map<string, IpBan>): void {
    const json = JSON.stringify({ names: [...names.values()], ips: [...ips.values()] }, null, 2) + "\n";
    writeFileAtomic(this.file, json);
    this.names = names;
    this.ips = ips;
  }

  findNameBan(name: string): NameBan | undefined {
    return this.names.get(name.toLowerCase());
  }

  findIpBan(ip: string): IpBan | undefined {
    return this.ips.get(normalizeIp(ip));
  }

  banName(name: string, reason: string, by: string): BanResult {
    if (!VALID_USERNAME.test(name)) return "invalid";
    if (this.names.has(name.toLowerCase())) return "already";
    const next = new Map(this.names).set(name.toLowerCase(), { name, reason, by, date: new Date().toISOString() });
    this.commit(next, this.ips);
    return "banned";
  }

  unbanName(name: string): UnbanResult {
    if (!this.names.has(name.toLowerCase())) return "not-banned";
    const next = new Map(this.names);
    next.delete(name.toLowerCase());
    this.commit(next, this.ips);
    return "unbanned";
  }

  banIp(address: string, reason: string, by: string): BanResult {
    if (!isIpAddress(address)) return "invalid";
    const ip = normalizeIp(address);
    if (this.ips.has(ip)) return "already";
    const next = new Map(this.ips).set(ip, { ip, reason, by, date: new Date().toISOString() });
    this.commit(this.names, next);
    return "banned";
  }

  unbanIp(address: string): UnbanResult {
    const ip = normalizeIp(address);
    if (!this.ips.has(ip)) return "not-banned";
    const next = new Map(this.ips);
    next.delete(ip);
    this.commit(this.names, next);
    return "unbanned";
  }

  listNames(): NameBan[] {
    return [...this.names.values()];
  }

  listIps(): IpBan[] {
    return [...this.ips.values()];
  }
}
