import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { writeFileAtomic } from "../util/atomicWrite";
import { VALID_USERNAME } from "../util/username";
import { logger } from "../util/logger";
import { isOperatorName } from "./operators";
import type { MinecraftServer } from "./Server";

export const WHITELIST_MESSAGE = "You are not whitelisted on this server.";
/** Names, not UUIDs: direct offline logins and forwarded identities use different UUIDs. */
export class Whitelist {
  enabled = false;
  private names = new Map<string, string>();
  constructor(
    private readonly file = path.resolve("whitelist.json"),
    startup?: boolean,
  ) {
    this.reload();
    if (startup === true) this.enabled = true; // false/default does not erase a persisted /whitelist on
  }
  reload(): void {
    let text: string;
    try {
      if (fs.statSync(this.file).size > 1024 * 1024) throw new Error("file exceeds 1 MiB");
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // a reload must not silently disable active protection
      throw new Error(`Cannot read whitelist.json: ${String(error)}`);
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("whitelist.json must be an object");
    const { enabled, names } = data as Record<string, unknown>;
    if (typeof enabled !== "boolean" || !Array.isArray(names))
      throw new Error("whitelist.json requires enabled:boolean and names:array");
    const next = new Map<string, string>();
    let skipped = 0;
    for (const name of names) {
      if (typeof name === "string" && VALID_USERNAME.test(name)) next.set(name.toLowerCase(), name);
      else skipped++;
    }
    if (skipped) logger.warn(`whitelist.json: skipped ${skipped} invalid names.`);
    this.names = next;
    this.enabled = enabled;
  }
  list(): string[] {
    return [...this.names.values()].sort((a, b) => a.localeCompare(b));
  }
  allows(name: string): boolean {
    return !this.enabled || isOperatorName(name) || this.names.has(name.toLowerCase());
  }
  private commit(enabled: boolean, names: Map<string, string>): void {
    writeFileAtomic(this.file, JSON.stringify({ enabled, names: [...names.values()] }, null, 2) + "\n");
    this.enabled = enabled;
    this.names = names;
  }
  setEnabled(enabled: boolean): void {
    this.commit(enabled, this.names);
  }
  add(name: string): "added" | "already" | "invalid" {
    if (!VALID_USERNAME.test(name)) return "invalid";
    if (this.names.has(name.toLowerCase())) return "already";
    this.commit(this.enabled, new Map(this.names).set(name.toLowerCase(), name));
    return "added";
  }
  remove(name: string): boolean {
    if (!this.names.has(name.toLowerCase())) return false;
    const next = new Map(this.names);
    next.delete(name.toLowerCase());
    this.commit(this.enabled, next);
    return true;
  }
}
// Keep Server.ts ownership with the lead; each server still has its own cached list.
const lists = new WeakMap<MinecraftServer, Whitelist>();
export function whitelistFor(server: MinecraftServer): Whitelist {
  let list = lists.get(server);
  if (!list) {
    list = new Whitelist(path.resolve("whitelist.json"), config.whitelist);
    lists.set(server, list);
  }
  return list;
}
export function enforceWhitelist(server: MinecraftServer): number {
  const list = whitelistFor(server);
  const targets = server.getOnlinePlayers().filter((p) => !list.allows(p.username));
  for (const player of targets) player.kick(WHITELIST_MESSAGE);
  return targets.length;
}
