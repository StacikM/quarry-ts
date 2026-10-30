import type { MinecraftServer } from "../game/Server";
import type { Player } from "../game/Player";
import type { BlockPosition } from "../world/BlockPosition";

/**
 * CONTRACT for plugin authors. A plugin is an object like this:
 *
 *   export const myPlugin: Plugin = {
 *     name: "my-plugin",
 *     version: "1.0.0",
 *     onEnable(api) {
 *       api.on("playerJoin", ({ player }) => player.sendMessage("Welcome!"));
 *       api.registerCommand({ name: "hi", description: "Say hi", run: (p) => p.sendMessage("hi") });
 *     },
 *   };
 *
 * Everything a plugin registers through `api` is removed automatically when
 * the plugin is disabled, so plugins never need to clean up listeners.
 */
export interface Plugin {
  /** 1-32 letters, digits, "_" or "-". Used as the data file name. "core" is reserved. */
  name: string;
  version: string;
  onEnable(api: PluginApi): void;
  onDisable?(): void;
}

/** Events a plugin can listen to. Events with `cancelled` can be stopped. */
export interface ServerEvents {
  playerJoin: { player: Player };
  playerQuit: { player: Player };
  /**
   * `format` is the template for the line everyone sees. {player} and {message}
   * are filled in AFTER every handler has run, so it doesn't matter in which
   * order plugins edit `message`, `format` or `cancelled`. Default: "<{player}> {message}".
   * Never broadcast from inside this event; change the fields and let the server do it.
   */
  playerChat: { player: Player; message: string; format: string; cancelled: boolean };
  playerCommand: { player: Player; command: string; args: string[]; cancelled: boolean };
  playerMove: { player: Player; from: { x: number; y: number; z: number } };
  blockBreak: { player: Player; position: BlockPosition; state: number; cancelled: boolean };
  blockPlace: { player: Player; position: BlockPosition; state: number; cancelled: boolean };
}

export type EventName = keyof ServerEvents;

/**
 * Whoever runs a command: a player in game, or the server console.
 * Both can reply with sendMessage. Colour codes like "§a" work in game and are removed in the console.
 */
export interface CommandSender {
  readonly server: MinecraftServer;
  /** The player's name, or "Console". */
  readonly name: string;
  readonly isOp: boolean;
  readonly isConsole: boolean;
  sendMessage(text: string, color?: string): void;
}

export interface PluginCommand {
  name: string;
  description: string;
  usage?: string;
  /** If true, only operators (config.ops) can run it. The console always can. */
  opOnly?: boolean;
  /** Runs the command for a player. */
  run(player: Player, args: string[]): void;
  /**
   * Optional: lets the server console run this command too. Commands that need
   * a player (like /tp or /home) leave it out, and the console says they can only be used in game.
   */
  runConsole?(sender: CommandSender, args: string[]): void;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginApi {
  readonly server: MinecraftServer;
  readonly logger: PluginLogger;

  on<E extends EventName>(event: E, handler: (event: ServerEvents[E]) => void): void;
  /** Returns false (and logs a warning) if another command already uses that name. */
  registerCommand(command: PluginCommand): boolean;

  /** Run `fn` once after `ticks` server ticks (20 ticks = 1 second). */
  runLater(ticks: number, fn: () => void): void;
  /** Run `fn` every `ticks` ticks until the plugin is disabled. */
  runRepeating(ticks: number, fn: () => void): void;

  /**
   * A JSON file in plugins-data/<plugin name>.json for saving small amounts of data.
   * Returns `fallback` if there is no file, it can't be parsed, or `validate`
   * (a type guard you write) says the contents have the wrong shape.
   */
  loadData<T>(fallback: T, validate?: (value: unknown) => value is T): T;
  saveData(data: unknown): void;
}
