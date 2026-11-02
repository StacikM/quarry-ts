/**
 * The rules of the WorldGuard plugin, without anything about players or packets, so they are easy to read and test.
 *
 * A region is a box with a name, owners, members and flags. A block or a position can be in several regions;
 * only the regions with the highest priority at that spot count.
 *
 *   build / block-break / block-place   who may break or place blocks there
 *       not set  -> only the owners and members
 *       allow    -> everybody
 *       deny     -> nobody (operators still can, unless they turned their bypass off)
 *     block-break and block-place win over build for their own action.
 *   tnt            whether explosions may destroy blocks there
 *       not set  -> protected, in a real region (the global region has nothing protected until you set deny)
 *       allow    -> they may
 *       deny     -> they may not
 *   entry          deny -> only owners and members may walk into the region
 *   greeting / farewell / deny-message   text ("&a" colour codes work)
 *
 * The region named __global__ covers the whole world and has no owners. With nothing set it protects nothing:
 * /rg flag __global__ build deny makes the whole world read-only.
 */

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export interface Region {
  id: string;
  /** The corners of the box. The global region has none. */
  min?: Pos;
  max?: Pos;
  priority: number;
  /** Lower case player names. */
  owners: string[];
  members: string[];
  flags: Record<string, string>;
}

export const GLOBAL_REGION = "__global__";

export const ALLOW_DENY_FLAGS = ["build", "block-break", "block-place", "entry", "tnt"] as const;
export const TEXT_FLAGS = ["greeting", "farewell", "deny-message"] as const;

export const DEFAULT_DENY_MESSAGE = "Hey! Sorry, but you can't build here.";
export const MAX_TEXT_LENGTH = 200;

export const validRegionId = (id: string): boolean => id === GLOBAL_REGION || /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id);
export const validPlayerName = (name: string): boolean => /^[A-Za-z0-9_]{1,16}$/.test(name);

export function contains(region: Region, pos: Pos): boolean {
  if (!region.min || !region.max) return region.id === GLOBAL_REGION;
  return (
    pos.x >= region.min.x && pos.x <= region.max.x &&
    pos.y >= region.min.y && pos.y <= region.max.y &&
    pos.z >= region.min.z && pos.z <= region.max.z
  );
}

export function isOwner(region: Region, name: string): boolean {
  return region.owners.includes(name.toLowerCase());
}

export function isMember(region: Region, name: string): boolean {
  return isOwner(region, name) || region.members.includes(name.toLowerCase());
}

/** The regions around a position that count: the ones with the highest priority. Highest first doesn't matter, they are equals. */
export function decisiveRegions(regions: Iterable<Region>, pos: Pos): Region[] {
  const here = [...regions].filter((region) => contains(region, pos));
  const top = Math.max(...here.map((region) => region.priority));
  return here.filter((region) => region.priority === top);
}

export type BuildAction = "block-break" | "block-place";

/** Whether this player may break or place a block here. When not, `message` is what to tell them. */
export function checkBuild(regions: Iterable<Region>, name: string, pos: Pos, action: BuildAction): { allowed: true } | { allowed: false; message: string } {
  for (const region of decisiveRegions(regions, pos)) {
    const rule = region.flags[action] ?? region.flags.build;
    const allowed = rule === "allow" || (rule === undefined && (region.id === GLOBAL_REGION || isMember(region, name)));
    if (!allowed) return { allowed: false, message: region.flags["deny-message"] ?? DEFAULT_DENY_MESSAGE };
  }
  return { allowed: true };
}

/** Whether an explosion may destroy the block at this position. */
export function explosionMayDestroy(regions: Iterable<Region>, pos: Pos): boolean {
  return decisiveRegions(regions, pos).every((region) => {
    const rule = region.flags.tnt;
    return rule === "allow" || (rule === undefined && region.id === GLOBAL_REGION);
  });
}

/** Whether this player may walk into this position, going by the entry flag of the regions there. */
export function checkEntry(regions: Iterable<Region>, name: string, pos: Pos): boolean {
  return decisiveRegions(regions, pos).every((region) => region.id === GLOBAL_REGION || region.flags.entry !== "deny" || isMember(region, name));
}

/** The ids of the real (not global) regions at a position, whatever their priority. */
export function regionIdsAt(regions: Iterable<Region>, pos: Pos): Set<string> {
  const ids = new Set<string>();
  for (const region of regions) if (region.id !== GLOBAL_REGION && contains(region, pos)) ids.add(region.id);
  return ids;
}

/** "&a" becomes the colour code that clients understand, and nothing else is let through. */
export function colorize(text: string): string {
  return text.replace(/&([0-9a-fk-or])/gi, "§$1").replace(/[\u0000-\u001f\u007f]/g, "");
}

const isPos = (value: unknown): value is Pos =>
  typeof value === "object" && value !== null &&
  [(value as Pos).x, (value as Pos).y, (value as Pos).z].every((n) => Number.isInteger(n) && Math.abs(n) < 30_000_000);

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === "string" && validPlayerName(name));

/** Reads the saved file. A damaged entry is skipped on its own, so one bad region doesn't lose all the others. */
export function readRegions(raw: unknown): Region[] {
  const list = (raw as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(list)) return [];
  const regions: Region[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, min, max, priority, owners, members, flags } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !validRegionId(id) || regions.some((r) => r.id === id)) continue;
    if (id !== GLOBAL_REGION && !(isPos(min) && isPos(max))) continue;
    if (!Number.isInteger(priority) || !isNames(owners) || !isNames(members)) continue;
    if (typeof flags !== "object" || flags === null || Object.values(flags).some((value) => typeof value !== "string")) continue;
    const region: Region = {
      id,
      priority: priority as number,
      owners: (owners as string[]).map((name) => name.toLowerCase()),
      members: (members as string[]).map((name) => name.toLowerCase()),
      flags: { ...(flags as Record<string, string>) },
    };
    if (id !== GLOBAL_REGION) {
      region.min = { x: (min as Pos).x, y: (min as Pos).y, z: (min as Pos).z };
      region.max = { x: (max as Pos).x, y: (max as Pos).y, z: (max as Pos).z };
    }
    regions.push(region);
  }
  return regions;
}
