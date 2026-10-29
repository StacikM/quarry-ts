import path from "node:path";
import { config } from "../config";
import { VALID_USERNAME } from "../util/username";
import { writeFileAtomic } from "../util/atomicWrite";

/**
 * Adding and removing operators while the server runs.
 *
 * The list lives in config.ops (what the permission checks read) and in
 * ops.json (so it survives a restart). ops.json is kept out of git.
 * Names are compared ignoring upper/lower case.
 */

export type AddResult = "added" | "already" | "invalid";
export type RemoveResult = "removed" | "not-an-operator";

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Writes the new list to disk first. Only if that works do we change the list in memory. */
function replaceOperators(next: string[]): void {
  writeFileAtomic(path.resolve("ops.json"), JSON.stringify(next, null, 2) + "\n");
  config.ops.splice(0, config.ops.length, ...next);
}

export function addOperator(name: string): AddResult {
  if (!VALID_USERNAME.test(name)) return "invalid";
  if (config.ops.some((existing) => sameName(existing, name))) return "already";
  replaceOperators([...config.ops, name]);
  return "added";
}

export function removeOperator(name: string): RemoveResult {
  if (!config.ops.some((existing) => sameName(existing, name))) return "not-an-operator";
  replaceOperators(config.ops.filter((existing) => !sameName(existing, name)));
  return "removed";
}

export function listOperators(): string[] {
  return [...config.ops];
}
