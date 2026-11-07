import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./util/atomicWrite";
import { logger } from "./util/logger";

/**
 * config.json: every setting of the server in one file, so nothing has to be changed in a hosting panel's egg.
 *
 * - The first time the server starts it writes the file with every setting and its default value.
 * - When an update adds a new setting, the next start adds it to the file with its default value. The values you
 *   wrote yourself are never changed.
 * - Older versions wrote server.json. If there is no config.json, its settings are moved into one, and the old
 *   file is kept as server.json.old.
 */
export const SETTINGS_FILE = "config.json";
export const LEGACY_SETTINGS_FILE = "server.json";

/** What a new config.json contains. null means "not set": no fixed seed (a random one is made), no map folder. */
export const DEFAULT_SETTINGS = {
  port: 25565,
  motd: "A Minecraft server written in TypeScript",
  maxPlayers: 20,
  viewDistance: 6,
  generator: "natural",
  seed: null as number | string | null,
  mapFolder: null as string | null,
  protectWorld: false,
  whitelist: false,
  pvp: true,
  respawn: { immediate: false, keepInventory: true, deathMessages: true },
  checkForUpdates: true,
  requiredPlugins: [] as string[],
};

/** The settings in a file, or null if there is no such file. A file that is not a JSON object is an error. */
export function readSettingsObject(file: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("it must be a JSON object");
    return data as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot use ${path.basename(file)}: ${(err as Error).message}`);
  }
}

/** Creates config.json, or adds the settings that an update introduced. Call it once when the server starts. */
export function ensureSettingsFile(dir: string = process.cwd()): void {
  const file = path.join(dir, SETTINGS_FILE);
  const legacy = path.join(dir, LEGACY_SETTINGS_FILE);
  let current = readSettingsObject(file);
  const existed = current !== null;
  const fromLegacy = !existed && fs.existsSync(legacy);
  if (!current) current = fromLegacy ? readSettingsObject(legacy) ?? {} : {};

  const added: string[] = [];
  const merged: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in current)) {
      merged[key] = structuredClone(fallback);
      added.push(key);
    } else if (key === "respawn" && current.respawn !== null && typeof current.respawn === "object" && !Array.isArray(current.respawn)) {
      const respawn: Record<string, unknown> = { ...(current.respawn as Record<string, unknown>) };
      for (const [name, value] of Object.entries(DEFAULT_SETTINGS.respawn)) {
        if (!(name in respawn)) {
          respawn[name] = value;
          added.push(`respawn.${name}`);
        }
      }
      merged[key] = respawn;
    } else {
      merged[key] = current[key];
    }
  }
  for (const [key, value] of Object.entries(current)) if (!(key in merged)) merged[key] = value; // settings this version does not know are kept

  if (existed && added.length === 0) return; // nothing to add: leave the file exactly as it is

  try {
    writeFileAtomic(file, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    logger.warn(`Could not write ${SETTINGS_FILE}: ${(err as Error).message}. The server runs with the settings it has.`);
    return;
  }
  if (fromLegacy) {
    try {
      fs.renameSync(legacy, `${legacy}.old`);
    } catch {
      // the old file stays where it is; config.json wins from now on
    }
    logger.info(`The settings of ${LEGACY_SETTINGS_FILE} were moved into ${SETTINGS_FILE} (the old file is kept as ${LEGACY_SETTINGS_FILE}.old). Edit ${SETTINGS_FILE} from now on.`);
  } else if (!existed) {
    logger.info(`Created ${SETTINGS_FILE} with every setting at its default. Edit it and restart the server to change them.`);
  } else {
    logger.info(`${SETTINGS_FILE}: added the new settings ${added.join(", ")} with their default values. The values you set were not changed.`);
  }
}
