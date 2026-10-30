import fs from "node:fs";
import path from "node:path";
import { GameMode } from "./game/GameMode";

/**
 * Operators live in a file called ops.json next to where you start the server,
 * e.g. ["YourMinecraftName"]. It is kept out of git, so your name is never
 * committed. No file means no operators. The environment variable QUARRY_OPS (names separated by commas)
 * adds more, for hosting panels.
 */
function loadOperators(): string[] {
  const fromEnv = (process.env.QUARRY_OPS ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  try {
    const names: unknown = JSON.parse(fs.readFileSync(path.resolve("ops.json"), "utf8"));
    return [...(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []), ...fromEnv];
  } catch {
    return fromEnv;
  }
}

/**
 * Settings for running behind a Velocity proxy, read from velocity.json:
 *   { "enabled": true, "secret": "the same text as in Velocity's forwarding.secret" }
 * The file is kept out of git because it holds a password. You can also set the
 * environment variable QUARRY_VELOCITY_SECRET instead (that turns it on too).
 * With no file and no variable, players connect to the server directly.
 */
function loadVelocity(): { enabled: boolean; secret: string } {
  const fromEnv = process.env.QUARRY_VELOCITY_SECRET?.trim();
  if (fromEnv) return { enabled: true, secret: fromEnv };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.resolve("velocity.json"), "utf8"));
    const { enabled, secret } = (data ?? {}) as { enabled?: unknown; secret?: unknown };
    if (enabled === true && typeof secret === "string" && secret.trim().length > 0) {
      return { enabled: true, secret: secret.trim() };
    }
    if (enabled === true) throw new Error("velocity.json says enabled but has no secret");
  } catch (err) {
    // A missing file is normal. A broken one must not silently switch protection off.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot use velocity.json: ${(err as Error).message}`);
    }
  }
  return { enabled: false, secret: "" };
}

/**
 * Settings from server.json (written by the installer, or by hand). Every key is optional:
 *   { "port": 25565, "motd": "...", "maxPlayers": 20, "viewDistance": 6, "generator": "natural",
 *     "seed": 1234, "mapFolder": "maps/lobby", "protectWorld": true }
 * An environment variable with the same job (QUARRY_PORT, QUARRY_SEED, QUARRY_GENERATOR, QUARRY_MOTD,
 * QUARRY_MAX_PLAYERS, QUARRY_VIEW_DISTANCE, QUARRY_MAP, QUARRY_PROTECT_WORLD) wins over the file: that is how
 * hosting panels such as Pterodactyl configure the server. An empty variable counts as not set.
 */
interface Settings {
  port?: number;
  motd?: string;
  maxPlayers?: number;
  viewDistance?: number;
  generator?: "natural" | "flat" | "void";
  seed?: number;
  mapFolder?: string;
  protectWorld?: boolean;
  whitelist?: boolean;
}

/** A text seed (like in vanilla) becomes a number the same way every time. A number stays itself. */
export function seedFromText(text: string): number {
  if (/^-?\d{1,10}$/.test(text)) return Number(text) | 0;
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  return hash;
}

function loadSettings(): Settings {
  let file: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.resolve("server.json"), "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("it must be a JSON object");
    file = data as Record<string, unknown>;
  } catch (err) {
    // A missing file is normal. A broken one must not be silently ignored.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot use server.json: ${(err as Error).message}`);
  }

  const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
  const integer = (what: string, value: unknown, min: number, max: number): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${what} must be a whole number from ${min} to ${max}, not "${String(value)}"`);
    }
    return number;
  };
  const text = (what: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${what} must be text`);
    return value;
  };

  const settings: Settings = {};
  settings.port = integer("the port", env("QUARRY_PORT") ?? env("SERVER_PORT") ?? file.port, 1, 65535);
  settings.maxPlayers = integer("maxPlayers", env("QUARRY_MAX_PLAYERS") ?? file.maxPlayers, 1, 100_000);
  settings.viewDistance = integer("viewDistance", env("QUARRY_VIEW_DISTANCE") ?? file.viewDistance, 2, 32);
  settings.motd = text("motd", env("QUARRY_MOTD") ?? file.motd);
  settings.mapFolder = text("mapFolder", env("QUARRY_MAP") ?? file.mapFolder);

  const generator = text("generator", env("QUARRY_GENERATOR") ?? file.generator);
  if (generator !== undefined) {
    if (generator !== "natural" && generator !== "flat" && generator !== "void") throw new Error(`generator must be natural, flat or void, not "${generator}"`);
    settings.generator = generator;
  }

  const seed = env("QUARRY_SEED") ?? file.seed;
  if (seed !== undefined && seed !== "") settings.seed = typeof seed === "number" ? seed | 0 : seedFromText(String(seed));

  const protect = env("QUARRY_PROTECT_WORLD") ?? file.protectWorld;
  if (protect !== undefined) {
    if (protect !== true && protect !== false && protect !== "true" && protect !== "false") throw new Error("protectWorld must be true or false");
    settings.protectWorld = protect === true || protect === "true";
  }
  const whitelist = env("QUARRY_WHITELIST") ?? file.whitelist;
  if (whitelist !== undefined) {
    if (whitelist !== true && whitelist !== false && whitelist !== "true" && whitelist !== "false") throw new Error("whitelist must be true or false");
    settings.whitelist = whitelist === true || whitelist === "true";
  }
  return settings;
}
const settings = loadSettings();

/**
 * All the knobs you might want to turn live here.
 */
export const config = {
  host: "0.0.0.0",
  /** The port to listen on (server.json, or the environment variable QUARRY_PORT). */
  port: settings.port ?? 25565,

  /** Text shown under the server name in the multiplayer list. */
  motd: settings.motd ?? "A Minecraft server written in TypeScript",
  maxPlayers: settings.maxPlayers ?? 20,
  /** true forces protection on at startup; false/absent preserves whitelist.json. */
  whitelist: settings.whitelist,

  /** How many chunks around the player we send (in each direction). */
  viewDistance: settings.viewDistance ?? 6,

  /**
   * Chunks are sent a few per tick instead of all at once, so teleporting or
   * flying never freezes the server. This is how many milliseconds of each
   * 50 ms tick may be spent preparing and sending chunks (shared by all players).
   * Higher loads the world faster but risks lag; lower is smoother but slower.
   */
  chunkBudgetMs: 10,

  /**
   * When a player joins or teleports, the chunks within this many chunks of them
   * are sent immediately (1 = the 3x3 around them) so they always have ground
   * to stand on. The rest stream in over the next ticks, nearest first.
   */
  urgentChunkRadius: 1,

  defaultGameMode: GameMode.Creative,

  /** The time of day shown to players, in ticks: 0 sunrise, 6000 noon, 12000 sunset, 18000 midnight. The clock does not move. */
  timeOfDay: 6000,

  /** Behind a Velocity proxy? See loadVelocity() above. When on, direct connections are refused. */
  velocity: loadVelocity(),

  /**
   * Packets of at least this many bytes are compressed before they are sent
   * (-1 turns compression off). Chunks shrink to a small fraction of their size.
   */
  compressionThreshold: 256,

  /** Operators (case-insensitive) can run commands marked opOnly. Edit ops.json, not this file. */
  ops: loadOperators(),

  /** How often changed chunks are written to disk (they are also saved when the server stops). */
  autosaveIntervalMs: 60_000,

  /**
   * Same seed => same world. Left out of server.json, a random seed is made the first time the server
   * starts and kept in world/seed.txt, so every server gets its own world (see game/createWorld.ts).
   */
  seed: settings.seed ?? (null as number | null),

  /**
   * "flat" or "natural". If the natural terrain code is missing, the server
   * falls back to flat (see game/createWorld.ts).
   */
  generator: settings.generator ?? ("natural" as "flat" | "natural" | "void"),

  /**
   * Lobby behaviour. With protectWorld on, only operators can build or break blocks
   * and everybody else joins in adventure mode (see plugins/builtin/lobby.ts).
   */
  lobby: { protectWorld: settings.protectWorld ?? false },

  /**
   * An existing Minecraft world to show as this server's map: the folder that holds its "region" folder
   * (a 1.18 or newer world from vanilla, Paper...). Or set the environment variable QUARRY_MAP.
   * Empty means: use the generator above. See world/anvil/AnvilGenerator.ts for what is loaded.
   */
  mapFolder: settings.mapFolder ?? "",

  /**
   * Where players appear. Without a y, the height is looked up from the world at join time.
   * With a map, the map's own spawn point (from its level.dat) is used instead, unless you set
   * useMapSpawn to false.
   */
  spawn: { x: 0.5, z: 0.5 } as { x: number; y?: number; z: number },
  useMapSpawn: true,

  /** We send a keep-alive this often... */
  keepAliveIntervalMs: 10_000,
  /** ...and kick players that haven't answered one for this long. */
  keepAliveTimeoutMs: 30_000,
};

/** Minecraft 1.21.11 is protocol version 774. */
export const PROTOCOL_VERSION = 774;
export const VERSION_NAME = "1.21.11";
