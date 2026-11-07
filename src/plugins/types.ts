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

/** A skin: the "textures" profile property, as Mojang's session server (or a proxy) hands it out. */
export interface SkinData {
  value: string;
  signature?: string;
}

/** What an NPC wears or holds in one place: an item name (with or without "minecraft:"), and the colour of dyed leather armor. */
export interface NpcItem {
  item: string;
  /** Leather armor colour as 0xRRGGBB. */
  dyedColor?: number;
}

export interface NpcEquipment {
  mainHand?: NpcItem;
  offHand?: NpcItem;
  head?: NpcItem;
  chest?: NpcItem;
  legs?: NpcItem;
  feet?: NpcItem;
}

/**
 * A non-player character: a fake player standing in the world that everybody can see.
 * It is plain data, so plugins can save it (see PluginApi.loadData) and spawn it again after a restart.
 */
export interface NpcDefinition {
  /** Your own unique name for it, 1-64 letters, digits, "_", "-" or ".". Used to find and remove it. */
  id: string;
  position: { x: number; y: number; z: number };
  /** Degrees. 0 faces south, 90 west, 180 north, 270 east (like the player's yaw). */
  yaw?: number;
  /** Degrees. Positive looks down. */
  pitch?: number;
  /** The text shown above its head ("§" colour codes work). Empty or missing: no name tag. */
  name?: string;
  skin?: SkinData;
  /** What it holds and wears. Anything with an unknown item is refused when spawning. */
  equipment?: NpcEquipment;
  /** Turn to face players who come close. */
  lookAtPlayers?: boolean;
  /** Size multiplier (1 = normal). */
  scale?: number;
  glowing?: boolean;
}

/** A spawned NPC. Changes are shown to everybody at once. */
export interface Npc {
  readonly id: string;
  /** The entity number clients know it by. */
  readonly entityId: number;
  readonly definition: Readonly<NpcDefinition>;
  teleport(position: { x: number; y: number; z: number }, yaw?: number, pitch?: number): void;
  setName(name: string): void;
  setSkin(skin: SkinData | undefined): void;
  /** Replaces everything it holds and wears. */
  setEquipment(equipment: NpcEquipment | undefined): void;
  /** Takes it out of the world. */
  remove(): void;
}

export interface NpcApi {
  /** Spawns it for everyone online and for everyone who joins later. Returns null (and logs why) if the id is taken or invalid. */
  spawn(definition: NpcDefinition): Npc | null;
  get(id: string): Npc | undefined;
  list(): Npc[];
}

/** Events a plugin can listen to. Events with `cancelled` can be stopped. */
export interface ServerEvents {
  /** Raw inbound plugin-channel payload from a client. Channel names do not authenticate the sender. */
  pluginMessage: { player: Player; channel: string; data: Buffer };
  /** Main hand slot is 0-8; offhand slot is 45. Fires for air and block use. */
  itemUse: { player: Player; hand: 0 | 1; slot: number; item: string | undefined; cancelled: boolean };
  playerDamage: { player: Player; attacker?: Player; damage: number; cause: string; cancelled: boolean };
  /**
   * A player is about to die (their health would reach 0). Cancel to keep them alive (a duel plugin does this to end the
   * match instead). `cause` is "melee", "arrow", "explosion", "void", "kill" or what a plugin gave to combat.damage();
   * `message` is the sentence everybody reads, which a plugin can change, or set to null to say nothing.
   */
  playerDeath: { player: Player; killer?: Player; cause: string; message: string | null; cancelled: boolean };
  /**
   * A dead player is coming back (they pressed "Respawn", or something called player.respawn()). Change `position` to
   * choose where they appear (the world spawn by default) and `keepInventory` to choose whether they keep their items
   * (config.json decides by default). It cannot be cancelled: the player has to come back somewhere.
   */
  playerRespawn: { player: Player; position: { x: number; y: number; z: number; yaw?: number; pitch?: number }; keepInventory: boolean };
  /** The respawn is finished: the player is alive, at their new place, and everybody has been told. A good moment to hand out starting items. */
  playerRespawned: { player: Player };
  playerAttack: { player: Player; targetEntityId: number; cancelled: boolean };
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
  playerEntityInteract: { player: Player; target: Player; sneaking: boolean; cancelled: boolean };
  inventoryClick: { player: Player; windowId: number; cancelled: boolean };
  playerFlight: { player: Player; flying: boolean; cancelled: boolean };
  blockBreak: { player: Player; position: BlockPosition; state: number; cancelled: boolean };
  blockPlace: { player: Player; position: BlockPosition; state: number; cancelled: boolean };
  /**
   * A player left-clicked ("left", starting to dig) or right-clicked ("right", with the main hand) a block.
   * `item` is the name of the item in that hand without "minecraft:" ("wooden_axe"), or undefined when it is empty.
   * Cancel to stop what the click would do (break the block, place a block, open a door): the client is corrected.
   * It comes before blockBreak and blockPlace, which still fire for clicks that are not cancelled.
   */
  playerInteract: { player: Player; position: BlockPosition; face: number; click: "left" | "right"; item: string | undefined; cancelled: boolean };
  /**
   * An explosion is about to happen at `position` (TNT, or a plugin calling `server.explosions.explode`).
   * `blocks` are the blocks it will destroy: remove entries to protect them, or set `cancelled` to stop the whole thing.
   */
  explosion: { position: { x: number; y: number; z: number }; power: number; blocks: BlockPosition[]; cancelled: boolean };
  /** A player left-clicked ("left") or right-clicked ("right") an NPC. Sneaking is passed on. */
  npcInteract: { player: Player; npc: Npc; click: "left" | "right"; sneaking: boolean };
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

  /** Non-player characters (see NpcDefinition). They are removed when the plugin is disabled. */
  readonly npcs: NpcApi;

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
