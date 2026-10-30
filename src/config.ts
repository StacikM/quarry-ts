import fs from "node:fs";
import path from "node:path";
import { GameMode } from "./game/GameMode";

/**
 * Operators live in a file called ops.json next to where you start the server,
 * e.g. ["YourMinecraftName"]. It is kept out of git, so your name is never
 * committed. No file means no operators.
 */
function loadOperators(): string[] {
  try {
    const names: unknown = JSON.parse(fs.readFileSync(path.resolve("ops.json"), "utf8"));
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
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
 * All the knobs you might want to turn live here.
 */
export const config = {
  host: "0.0.0.0",
  /** The port to listen on. Set the environment variable QUARRY_PORT to use another one. */
  port: Number(process.env.QUARRY_PORT) || 25565,

  /** Text shown under the server name in the multiplayer list. */
  motd: "A Minecraft server written in TypeScript",
  maxPlayers: 20,

  /** How many chunks around the player we send (in each direction). */
  viewDistance: 6,

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

  /** Same seed => same world. Change it for a different world. */
  seed: 1337,

  /**
   * "flat" or "natural". If the natural terrain code is missing, the server
   * falls back to flat (see game/createWorld.ts).
   */
  generator: "natural" as "flat" | "natural" | "void",

  /**
   * Lobby behaviour. With protectWorld on, only operators can build or break blocks
   * and everybody else joins in adventure mode (see plugins/builtin/lobby.ts).
   */
  lobby: { protectWorld: false },

  /**
   * An existing Minecraft world to show as this server's map: the folder that holds its "region" folder
   * (a 1.18 or newer world from vanilla, Paper...). Or set the environment variable QUARRY_MAP.
   * Empty means: use the generator above. See world/anvil/AnvilGenerator.ts for what is loaded.
   */
  mapFolder: process.env.QUARRY_MAP ?? "",

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
