/**
 * One function per packet the server sends to clients.
 *
 * Each function just writes the fields in the order the protocol expects
 * and returns the PacketWriter. To send one: player.send(systemChat(...))
 */
import { PacketWriter } from "../network/PacketWriter";
import { ConfigOut, LoginOut, PlayOut, StatusOut } from "./packetIds";
import { REGISTRY_KEYS } from "./registryKeys";
import { allTags } from "./tags";
import { encodeChunk } from "./chunkEncoding";
import type { Player } from "../game/Player";
import type { ProfileProperty } from "../network/Connection";
import type { Chunk } from "../world/Chunk";
import type { ChunkLight } from "../world/lighting";
import type { BlockPosition } from "../world/BlockPosition";
import { GameMode } from "../game/GameMode";

/** A chat "component". Minecraft supports much more, but this is enough. */
export interface ChatComponent {
  text: string;
  color?: string; // "yellow", "red", "gray", ...
}

const OVERWORLD = "minecraft:overworld";

/** Entity type number of a player in the 1.21.11 entity registry (checked against minecraft-data in protocol-check). */
export const PLAYER_ENTITY_TYPE = 155;

/** Sea level sent to the client (the water surface height of our terrain). */
const SEA_LEVEL = 63;

// ---------------------------------------------------------------- Status ---

export function statusResponse(json: object): PacketWriter {
  return new PacketWriter(StatusOut.Response).writeString(JSON.stringify(json));
}

export function pong(payload: bigint): PacketWriter {
  return new PacketWriter(StatusOut.Pong).writeLong(payload);
}

// ----------------------------------------------------------------- Login ---

/** Login errors are JSON text; this is the only place that still is. */
export function loginDisconnect(reason: ChatComponent): PacketWriter {
  return new PacketWriter(LoginOut.Disconnect).writeChat(reason);
}

export function loginSuccess(uuid: string, username: string): PacketWriter {
  return new PacketWriter(LoginOut.LoginSuccess)
    .writeUUID(uuid)
    .writeString(username)
    .writeVarInt(0); // properties (skins come from here; offline mode has none)
}

/** From now on, packets of at least `threshold` bytes are compressed in both directions. */
export function setCompression(threshold: number): PacketWriter {
  return new PacketWriter(LoginOut.SetCompression).writeVarInt(threshold);
}

/** Asks a Velocity proxy for the player's real identity. See handlers/login.ts. */
export function velocityPlayerInfoRequest(messageId: number, maxVersion: number): PacketWriter {
  return new PacketWriter(LoginOut.PluginRequest)
    .writeVarInt(messageId)
    .writeString("velocity:player_info")
    .writeUnsignedByte(maxVersion);
}

// --------------------------------------------------------- Configuration ---

export function configDisconnect(reason: ChatComponent): PacketWriter {
  return new PacketWriter(ConfigOut.Disconnect).writeTextComponent(reason);
}

/** Tells the client what software the server is (shown in the F3 screen). */
export function serverBrand(brand: string): PacketWriter {
  return new PacketWriter(ConfigOut.PluginMessage).writeString("minecraft:brand").writeString(brand);
}

export function featureFlags(flags: string[]): PacketWriter {
  const packet = new PacketWriter(ConfigOut.FeatureFlags).writeVarInt(flags.length);
  for (const flag of flags) packet.writeString(flag);
  return packet;
}

/**
 * "Do you have the standard game data?" If the client says yes, we only have to
 * send the NAMES of biomes, damage types and so on, not their (large) definitions.
 */
export function knownPacksRequest(version: string): PacketWriter {
  return new PacketWriter(ConfigOut.KnownPacks)
    .writeVarInt(1)
    .writeString("minecraft")
    .writeString("core")
    .writeString(version);
}

/** One registry (a numbered list of things, e.g. all the biomes), by name only. */
export function registryData(registry: string, keys: readonly string[]): PacketWriter {
  const packet = new PacketWriter(ConfigOut.RegistryData).writeString(registry).writeVarInt(keys.length);
  for (const key of keys) {
    packet.writeString(key).writeBoolean(false); // false: no data, the client uses its own copy
  }
  return packet;
}

/** Every registry the client wants, in the order it expects them. */
export function allRegistryData(): PacketWriter[] {
  return Object.entries(REGISTRY_KEYS).map(([registry, keys]) => registryData(registry, keys));
}

/** The tag groups the client insists on having (see tags.ts). */
export function tagsPacket(): PacketWriter {
  const registries = allTags();
  const packet = new PacketWriter(ConfigOut.Tags).writeVarInt(registries.length);
  for (const { registry, tags } of registries) {
    packet.writeString(registry).writeVarInt(tags.length);
    for (const { name, entries } of tags) packet.writeString(name).writeVarIntArray(entries);
  }
  return packet;
}

export function finishConfiguration(): PacketWriter {
  return new PacketWriter(ConfigOut.FinishConfiguration);
}

// ------------------------------------------------------------------ Play ---

export function keepAlive(id: number): PacketWriter {
  return new PacketWriter(PlayOut.KeepAlive).writeLong(BigInt(id));
}

export function joinGame(entityId: number, gameMode: GameMode, maxPlayers: number, viewDistance: number): PacketWriter {
  const dimension = REGISTRY_KEYS["minecraft:dimension_type"].indexOf(OVERWORLD);
  if (dimension < 0) throw new Error("The dimension list has no overworld");
  return new PacketWriter(PlayOut.Login)
    .writeInt(entityId)
    .writeBoolean(false) // hardcore
    .writeVarInt(1) // the worlds that exist (just one)
    .writeString(OVERWORLD)
    .writeVarInt(maxPlayers) // only used for the tab list layout
    .writeVarInt(viewDistance)
    .writeVarInt(viewDistance) // simulation distance
    .writeBoolean(false) // reduced debug info (F3 screen)
    .writeBoolean(true) // show the respawn screen when dying
    .writeBoolean(false) // limited crafting
    .writeVarInt(dimension) // which dimension type this world uses
    .writeString(OVERWORLD) // world name
    .writeLong(0n) // hashed seed (only used for biome noise on the client)
    .writeByte(gameMode)
    .writeUnsignedByte(0xff) // previous game mode: -1, none
    .writeBoolean(false) // debug world
    .writeBoolean(false) // superflat world
    .writeBoolean(false) // no death location
    .writeVarInt(0) // portal cooldown
    .writeVarInt(SEA_LEVEL)
    .writeBoolean(false); // enforces secure chat
}

/** Game Event reasons we use. */
export const GameEvent = {
  ChangeGameMode: 3,
  LevelChunksLoadStart: 13,
} as const;

export function gameEvent(event: number, value: number): PacketWriter {
  return new PacketWriter(PlayOut.GameEvent).writeUnsignedByte(event).writeFloat(value);
}

/** Chat lines, kicks and so on. `overlay` shows the text above the hotbar instead of in the chat box. */
export function systemChat(message: ChatComponent, overlay = false): PacketWriter {
  return new PacketWriter(PlayOut.SystemChat).writeTextComponent(message).writeBoolean(overlay);
}

/** Big text in the middle of the screen. Send the times first, then the subtitle, then the title (which makes it appear). */
export function titleTimes(fadeInTicks: number, stayTicks: number, fadeOutTicks: number): PacketWriter {
  return new PacketWriter(PlayOut.SetTitleTimes).writeInt(fadeInTicks).writeInt(stayTicks).writeInt(fadeOutTicks);
}

export function titleSubtitle(subtitle: ChatComponent): PacketWriter {
  return new PacketWriter(PlayOut.SetTitleSubtitle).writeTextComponent(subtitle);
}

export function titleText(title: ChatComponent): PacketWriter {
  return new PacketWriter(PlayOut.SetTitleText).writeTextComponent(title);
}

export function clearTitles(): PacketWriter {
  return new PacketWriter(PlayOut.ClearTitles).writeBoolean(true); // true also forgets the times
}

/** A message on a plugin channel. Proxies such as Velocity listen on some of these. */
export function pluginMessage(channel: string, data: Buffer): PacketWriter {
  return new PacketWriter(PlayOut.PluginMessage).writeString(channel).writeBytes(data);
}

/** Where the compass points. */
export function spawnPosition(pos: BlockPosition): PacketWriter {
  return new PacketWriter(PlayOut.SetDefaultSpawnPosition)
    .writeString(OVERWORLD)
    .writePosition(pos)
    .writeFloat(0) // yaw
    .writeFloat(0); // pitch
}

/**
 * Moves the client's own player. The client answers with "Teleport Confirm"
 * carrying the same id, and stays on "Loading terrain" until the chunks have arrived.
 */
export function playerPosition(teleportId: number, x: number, y: number, z: number, yaw: number, pitch: number): PacketWriter {
  return new PacketWriter(PlayOut.PlayerPosition)
    .writeVarInt(teleportId)
    .writeDouble(x)
    .writeDouble(y)
    .writeDouble(z)
    .writeDouble(0) // velocity
    .writeDouble(0)
    .writeDouble(0)
    .writeFloat(yaw)
    .writeFloat(pitch)
    .writeInt(0); // relative flags: 0 means every value above is absolute
}

export function setCenterChunk(chunkX: number, chunkZ: number): PacketWriter {
  return new PacketWriter(PlayOut.SetCenterChunk).writeVarInt(chunkX).writeVarInt(chunkZ);
}

export function animation(entityId: number, animationId: number): PacketWriter {
  return new PacketWriter(PlayOut.Animation)
    .writeVarInt(entityId)
    .writeUnsignedByte(animationId); // 0 = swing main arm
}

/**
 * Makes another player appear. The client must already know this player
 * from the tab list (playerListAdd), or it won't show them.
 */
export function spawnPlayer(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.SpawnEntity)
    .writeVarInt(player.entityId)
    .writeUUID(player.uuid)
    .writeVarInt(PLAYER_ENTITY_TYPE)
    .writeDouble(player.x)
    .writeDouble(player.y)
    .writeDouble(player.z)
    .writeUnsignedByte(0) // velocity: one zero byte means "not moving"
    .writeAngle(player.pitch)
    .writeAngle(player.yaw)
    .writeAngle(player.yaw) // head rotation
    .writeVarInt(0); // extra data (unused for players)
}

export function destroyEntities(entityIds: number[]): PacketWriter {
  return new PacketWriter(PlayOut.RemoveEntities).writeVarIntArray(entityIds);
}

/** Entity type numbers in the 1.21.11 registry (checked against minecraft-data in protocol-check). */
export const ARMOR_STAND_ENTITY_TYPE = 5;

/** Any entity, standing still at a position. For players the tab list entry must come first (see playerListAdd). */
export function spawnEntity(entityId: number, uuid: string, entityType: number, x: number, y: number, z: number, yaw: number, pitch: number): PacketWriter {
  return new PacketWriter(PlayOut.SpawnEntity)
    .writeVarInt(entityId)
    .writeUUID(uuid)
    .writeVarInt(entityType)
    .writeDouble(x)
    .writeDouble(y)
    .writeDouble(z)
    .writeUnsignedByte(0) // velocity: one zero byte means "not moving"
    .writeAngle(pitch)
    .writeAngle(yaw)
    .writeAngle(yaw) // head rotation
    .writeVarInt(0); // extra data
}

/** One piece of entity data ("metadata"). `index` is the field number of that kind of entity; a wrong one makes the client throw. */
export type MetadataEntry =
  | { index: number; type: "byte"; value: number }
  | { index: number; type: "boolean"; value: boolean }
  | { index: number; type: "optionalComponent"; value: ChatComponent | null };

const METADATA_TYPE = { byte: 0, optionalComponent: 6, boolean: 8 } as const;

/** Entity data fields: entity 0 = flags (bit 5, 0x20, is invisible), 2 = custom name, 3 = whether the name shows. Player 17 = skin layers; armor stand 15 = flags. */
export function entityMetadata(entityId: number, entries: MetadataEntry[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.SetEntityData).writeVarInt(entityId);
  for (const entry of entries) {
    packet.writeUnsignedByte(entry.index).writeVarInt(METADATA_TYPE[entry.type]);
    if (entry.type === "byte") packet.writeByte(entry.value);
    else if (entry.type === "boolean") packet.writeBoolean(entry.value);
    else {
      packet.writeBoolean(entry.value !== null);
      if (entry.value !== null) packet.writeTextComponent(entry.value);
    }
  }
  return packet.writeUnsignedByte(0xff); // end of the list
}

/** Tells a player their own operator level (0-4): the client uses it to decide what it lets them try, like the F3+F4 game mode switcher. */
export function permissionLevel(playerEntityId: number, level: number): PacketWriter {
  return new PacketWriter(PlayOut.EntityStatus).writeInt(playerEntityId).writeByte(24 + level);
}

/** Moves and turns any entity (the "Entity Position Sync" packet). */
export function entityPositionSync(entityId: number, x: number, y: number, z: number, yaw: number, pitch: number): PacketWriter {
  return new PacketWriter(PlayOut.EntityPositionSync)
    .writeVarInt(entityId)
    .writeDouble(x)
    .writeDouble(y)
    .writeDouble(z)
    .writeDouble(0)
    .writeDouble(0)
    .writeDouble(0)
    .writeFloat(yaw)
    .writeFloat(pitch)
    .writeBoolean(true);
}

export function headRotation(entityId: number, yaw: number): PacketWriter {
  return new PacketWriter(PlayOut.HeadRotation).writeVarInt(entityId).writeAngle(yaw);
}

/** A tab list entry for a fake player (an NPC): carries its skin, and is not listed. */
export function npcListAdd(uuid: string, name: string, properties: ProfileProperty[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.PlayerInfoUpdate)
    .writeUnsignedByte(INFO_ADD_PLAYER | INFO_LISTED)
    .writeVarInt(1)
    .writeUUID(uuid)
    .writeString(name)
    .writeVarInt(properties.length);
  for (const property of properties) {
    packet.writeString(property.name).writeString(property.value).writeBoolean(property.signature !== undefined);
    if (property.signature !== undefined) packet.writeString(property.signature);
  }
  return packet.writeBoolean(false); // not shown in the tab list
}

/** A team whose members have no name tag above their head and no collision. Members are player names. */
export function teamWithHiddenNames(teamName: string, members: string[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.SetPlayerTeam)
    .writeString(teamName)
    .writeByte(0) // create
    .writeTextComponent({ text: teamName })
    .writeUnsignedByte(0) // flags
    .writeVarInt(1) // name tags: never
    .writeVarInt(1) // collision: never
    .writeVarInt(21) // team colour: reset (the number of "reset" in the game's list of formatting codes)
    .writeTextComponent({ text: "" }) // prefix
    .writeTextComponent({ text: "" }) // suffix
    .writeVarInt(members.length);
  for (const member of members) packet.writeString(member);
  return packet;
}

/** Takes a fake player out of the tab list (and with it the skin the client remembered for it). */
export function npcListRemove(uuid: string): PacketWriter {
  return new PacketWriter(PlayOut.PlayerInfoRemove).writeVarInt(1).writeUUID(uuid);
}

export function removeTeam(teamName: string): PacketWriter {
  return new PacketWriter(PlayOut.SetPlayerTeam).writeString(teamName).writeByte(1);
}

// ----------------------------------------------------------- Inventory ---

/** Selects a hotbar slot (0-8) on the client. */
export function setHeldSlot(slot: number): PacketWriter {
  return new PacketWriter(PlayOut.SetHeldSlot).writeVarInt(slot);
}

/** An item stack: nothing (count 0) or an item id with a count and no extra data. */
function writeItem(packet: PacketWriter, item: { itemId: number; count: number } | null): void {
  if (item === null || item.count <= 0 || item.itemId < 0) {
    packet.writeVarInt(0);
    return;
  }
  packet.writeVarInt(item.count).writeVarInt(item.itemId).writeVarInt(0).writeVarInt(0); // no component changes
}

/** Sets one slot of the player's own inventory window (0 = crafting result... 36-44 = hotbar, 9-35 = main). */
export function setInventorySlot(slot: number, item: { itemId: number; count: number } | null, stateId = 0): PacketWriter {
  const packet = new PacketWriter(PlayOut.ContainerSetSlot).writeUnsignedByte(0).writeVarInt(stateId).writeShort(slot);
  writeItem(packet, item);
  return packet;
}

/** Moves another player to an absolute position (the whole point of "Entity Position Sync"). */
export function entityTeleport(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.EntityPositionSync)
    .writeVarInt(player.entityId)
    .writeDouble(player.x)
    .writeDouble(player.y)
    .writeDouble(player.z)
    .writeDouble(0) // velocity
    .writeDouble(0)
    .writeDouble(0)
    .writeFloat(player.yaw)
    .writeFloat(player.pitch)
    .writeBoolean(player.onGround);
}

/** Body rotation and head rotation are separate; this turns the head. */
export function entityHeadLook(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.HeadRotation).writeVarInt(player.entityId).writeAngle(player.yaw);
}

export function chunkBatchStart(): PacketWriter {
  return new PacketWriter(PlayOut.ChunkBatchStart);
}

export function chunkBatchFinished(count: number): PacketWriter {
  return new PacketWriter(PlayOut.ChunkBatchFinished).writeVarInt(count);
}

export function chunkData(chunk: Chunk, light: ChunkLight): PacketWriter {
  const encoded = encodeChunk(chunk.getRawBlocks() as Uint16Array, chunk.getRawBiomes(), light);
  const packet = new PacketWriter(PlayOut.ChunkDataAndLight)
    .writeInt(chunk.x)
    .writeInt(chunk.z)
    .writeVarInt(encoded.heightmaps.length);
  for (const { type, data } of encoded.heightmaps) {
    packet.writeVarInt(type).writeLongArray(data);
  }
  packet
    .writeVarInt(encoded.data.length)
    .writeBytes(encoded.data)
    .writeVarInt(0) // block entities (chests, signs...): none
    .writeLongArray([encoded.skyLightMask])
    .writeLongArray([encoded.blockLightMask])
    .writeLongArray([encoded.emptySkyLightMask])
    .writeLongArray([encoded.emptyBlockLightMask])
    .writeVarInt(encoded.skyLight.length);
  for (const array of encoded.skyLight) packet.writeVarInt(array.length).writeBytes(array);
  packet.writeVarInt(encoded.blockLight.length);
  for (const array of encoded.blockLight) packet.writeVarInt(array.length).writeBytes(array);
  return packet;
}

export function unloadChunk(chunkX: number, chunkZ: number): PacketWriter {
  return new PacketWriter(PlayOut.UnloadChunk).writeInt(chunkZ).writeInt(chunkX); // z comes first
}

/** A block changed. `state` is the block state number (see world/blockStates.ts). */
export function blockChange(pos: BlockPosition, state: number): PacketWriter {
  return new PacketWriter(PlayOut.BlockUpdate).writePosition(pos).writeVarInt(state);
}

/** Confirms a dig or place the client sent with this sequence number, so it stops predicting. */
export function blockChangedAck(sequence: number): PacketWriter {
  return new PacketWriter(PlayOut.BlockChangedAck).writeVarInt(sequence);
}

/**
 * What the player may do. Bits: 1 invulnerable, 2 flying, 4 may fly, 8 creative (instant breaking).
 * The two floats are the flying speed and the field-of-view modifier of walking (vanilla: 0.05 and 0.1).
 */
export function playerAbilities(gameMode: GameMode, flying = false): PacketWriter {
  let flags = 0;
  if (gameMode === GameMode.Creative) flags = 1 | 4 | 8;
  if (gameMode === GameMode.Spectator) flags = 1 | 4;
  if (flags & 4 && flying) flags |= 2;
  return new PacketWriter(PlayOut.PlayerAbilities).writeByte(flags).writeFloat(0.05).writeFloat(0.1);
}

export function changeGameMode(gameMode: GameMode): PacketWriter {
  return gameEvent(GameEvent.ChangeGameMode, gameMode);
}

/** The time of day: ticks since the world began, the time of day, and whether the clock keeps running. */
export function timeUpdate(worldAge: number, timeOfDay: number, running: boolean): PacketWriter {
  return new PacketWriter(PlayOut.SetTime).writeLong(BigInt(worldAge)).writeLong(BigInt(timeOfDay)).writeBoolean(running);
}

// The Player Info Update packet controls the tab list. Its first field says which
// pieces of information follow for every player in it.
const INFO_ADD_PLAYER = 0x01;
const INFO_GAME_MODE = 0x04;
const INFO_LISTED = 0x08;
const INFO_LATENCY = 0x10;

export function playerListAdd(players: Player[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.PlayerInfoUpdate)
    .writeUnsignedByte(INFO_ADD_PLAYER | INFO_GAME_MODE | INFO_LISTED | INFO_LATENCY)
    .writeVarInt(players.length);

  for (const player of players) {
    packet
      .writeUUID(player.uuid)
      .writeString(player.username)
      .writeVarInt(player.properties.length); // profile data: the skin comes from here (a proxy supplies it; offline mode has none)
    for (const property of player.properties) {
      packet.writeString(property.name).writeString(property.value).writeBoolean(property.signature !== undefined);
      if (property.signature !== undefined) packet.writeString(property.signature);
    }
    packet
      .writeVarInt(player.gameMode)
      .writeBoolean(true) // shown in the tab list
      .writeVarInt(0); // ping in ms
  }
  return packet;
}

export function playerListUpdateGameMode(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.PlayerInfoUpdate)
    .writeUnsignedByte(INFO_GAME_MODE)
    .writeVarInt(1)
    .writeUUID(player.uuid)
    .writeVarInt(player.gameMode);
}

export function playerListRemove(players: Player[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.PlayerInfoRemove).writeVarInt(players.length);
  for (const player of players) {
    packet.writeUUID(player.uuid);
  }
  return packet;
}

/**
 * The command list that lets the client complete commands while typing and
 * colours valid ones. Every command takes free text after its name.
 */
export function commandTree(names: string[]): PacketWriter {
  const NODE_ROOT = 0;
  const NODE_LITERAL = 1;
  const NODE_ARGUMENT = 2;
  const HAS_EXECUTABLE = 0x04;

  // Node 0 is the root, then a command name and an argument node for each command.
  const packet = new PacketWriter(PlayOut.Commands).writeVarInt(1 + names.length * 2);
  packet.writeUnsignedByte(NODE_ROOT).writeVarIntArray(names.map((_, i) => 1 + i * 2));
  names.forEach((name, i) => {
    const literal = 1 + i * 2;
    packet
      .writeUnsignedByte(NODE_LITERAL | HAS_EXECUTABLE)
      .writeVarIntArray([literal + 1])
      .writeString(name);
    packet
      .writeUnsignedByte(NODE_ARGUMENT | HAS_EXECUTABLE)
      .writeVarIntArray([])
      .writeString("args")
      .writeVarInt(5) // parser 5: a string
      .writeVarInt(2); // 2: the rest of the line, spaces included
  });
  return packet.writeVarInt(0); // the root is node 0
}

export function playDisconnect(reason: ChatComponent): PacketWriter {
  return new PacketWriter(PlayOut.Disconnect).writeTextComponent(reason);
}
