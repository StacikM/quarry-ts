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
 * All the knobs you might want to turn live here.
 */
export const config = {
  host: "0.0.0.0",
  port: 25565,

  /** Text shown under the server name in the multiplayer list. */
  motd: "A Minecraft server written in TypeScript",
  maxPlayers: 20,

  /** How many chunks around the player we send (in each direction). */
  viewDistance: 6,

  defaultGameMode: GameMode.Creative,

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
  generator: "natural" as "flat" | "natural",

  /** Where players appear. The height is looked up from the world at join time. */
  spawn: { x: 0.5, z: 0.5 },

  /** We send a keep-alive this often... */
  keepAliveIntervalMs: 10_000,
  /** ...and kick players that haven't answered one for this long. */
  keepAliveTimeoutMs: 30_000,
};

/** 1.8 through 1.8.9 all use protocol version 47. */
export const PROTOCOL_VERSION = 47;
export const VERSION_NAME = "1.8.9";
