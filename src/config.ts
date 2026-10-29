import { GameMode } from "./game/GameMode";

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

  /** Operators (case-insensitive) can run commands marked opOnly. */
  ops: ["Stani"] as string[],

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
