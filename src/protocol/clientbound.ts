/**
 * One function per packet the server sends to clients.
 *
 * Each function just writes the fields in the order the protocol expects
 * and returns the PacketWriter. To send one: player.send(chatMessage(...))
 */
import { PacketWriter } from "../network/PacketWriter";
import { LoginOut, PlayOut, StatusOut } from "./packetIds";
import type { Player } from "../game/Player";
import type { Chunk } from "../world/Chunk";
import type { ChunkLight } from "../world/lighting";
import type { BlockPosition } from "../world/BlockPosition";
import type { GameMode } from "../game/GameMode";

/** A chat "component". Minecraft supports much more, but this is enough. */
export interface ChatComponent {
  text: string;
  color?: string; // "yellow", "red", "gray", ...
}

// ---------------------------------------------------------------- Status ---

export function statusResponse(json: object): PacketWriter {
  return new PacketWriter(StatusOut.Response).writeString(JSON.stringify(json));
}

export function pong(payload: bigint): PacketWriter {
  return new PacketWriter(StatusOut.Pong).writeLong(payload);
}

// ----------------------------------------------------------------- Login ---

export function loginDisconnect(reason: ChatComponent): PacketWriter {
  return new PacketWriter(LoginOut.Disconnect).writeChat(reason);
}

export function loginSuccess(uuid: string, username: string): PacketWriter {
  return new PacketWriter(LoginOut.LoginSuccess).writeString(uuid).writeString(username);
}

// ------------------------------------------------------------------ Play ---

export function keepAlive(id: number): PacketWriter {
  return new PacketWriter(PlayOut.KeepAlive).writeVarInt(id);
}

export function joinGame(entityId: number, gameMode: GameMode, maxPlayers: number): PacketWriter {
  return new PacketWriter(PlayOut.JoinGame)
    .writeInt(entityId)
    .writeUnsignedByte(gameMode)
    .writeByte(0) // dimension: -1 nether, 0 overworld, 1 end
    .writeUnsignedByte(0) // difficulty: 0 = peaceful
    .writeUnsignedByte(maxPlayers) // only used for the tab list layout
    .writeString("flat") // level type, changes how the sky/horizon looks
    .writeBoolean(false); // reduced debug info (F3 screen)
}

export function chatMessage(message: ChatComponent): PacketWriter {
  return new PacketWriter(PlayOut.ChatMessage)
    .writeChat(message)
    .writeByte(0); // 0 = chat box, 1 = system message, 2 = above hotbar
}

/** Where the compass points. */
export function spawnPosition(pos: BlockPosition): PacketWriter {
  return new PacketWriter(PlayOut.SpawnPosition).writePosition(pos);
}

/** Moves the client's own player. The client stays on "Downloading terrain" until it gets this. */
export function playerPositionAndLook(x: number, y: number, z: number, yaw: number, pitch: number): PacketWriter {
  return new PacketWriter(PlayOut.PlayerPositionAndLook)
    .writeDouble(x)
    .writeDouble(y)
    .writeDouble(z)
    .writeFloat(yaw)
    .writeFloat(pitch)
    .writeByte(0); // flags: 0 = all values are absolute, not relative
}

export function animation(entityId: number, animationId: number): PacketWriter {
  return new PacketWriter(PlayOut.Animation)
    .writeVarInt(entityId)
    .writeUnsignedByte(animationId); // 0 = swing arm
}

/**
 * Makes another player appear. The client must already know this player
 * from the tab list (playerListAdd), or it won't show them.
 */
export function spawnPlayer(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.SpawnPlayer)
    .writeVarInt(player.entityId)
    .writeUUID(player.uuid)
    .writeFixedPoint(player.x)
    .writeFixedPoint(player.y)
    .writeFixedPoint(player.z)
    .writeAngle(player.yaw)
    .writeAngle(player.pitch)
    .writeShort(0) // item in hand (0 = nothing)
    // Entity metadata: a list of (key, value) pairs ending with 0x7F.
    // The key byte is (type << 5) | index. Here: type 3 (float), index 6 (health).
    .writeUnsignedByte((3 << 5) | 6)
    .writeFloat(20)
    .writeUnsignedByte(0x7f);
}

export function destroyEntities(entityIds: number[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.DestroyEntities).writeVarInt(entityIds.length);
  for (const id of entityIds) {
    packet.writeVarInt(id);
  }
  return packet;
}

export function entityTeleport(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.EntityTeleport)
    .writeVarInt(player.entityId)
    .writeFixedPoint(player.x)
    .writeFixedPoint(player.y)
    .writeFixedPoint(player.z)
    .writeAngle(player.yaw)
    .writeAngle(player.pitch)
    .writeBoolean(player.onGround);
}

/** Body rotation and head rotation are separate; this turns the head. */
export function entityHeadLook(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.EntityHeadLook).writeVarInt(player.entityId).writeAngle(player.yaw);
}

export function chunkData(chunk: Chunk, light: ChunkLight): PacketWriter {
  const { sectionMask, data } = chunk.serialize(light);
  return new PacketWriter(PlayOut.ChunkData)
    .writeInt(chunk.x)
    .writeInt(chunk.z)
    .writeBoolean(true) // "ground-up continuous": this is the whole chunk, including biomes
    .writeUnsignedShort(sectionMask)
    .writeVarInt(data.length)
    .writeBytes(data);
}

/** In 1.8 you unload a chunk by sending it with no sections and no data. */
export function unloadChunk(chunkX: number, chunkZ: number): PacketWriter {
  return new PacketWriter(PlayOut.ChunkData)
    .writeInt(chunkX)
    .writeInt(chunkZ)
    .writeBoolean(true)
    .writeUnsignedShort(0)
    .writeVarInt(0);
}

/** Block states are sent as (blockId << 4) | metadata. */
export function blockChange(pos: BlockPosition, blockId: number, metadata: number): PacketWriter {
  return new PacketWriter(PlayOut.BlockChange).writePosition(pos).writeVarInt((blockId << 4) | metadata);
}

export function changeGameMode(gameMode: GameMode): PacketWriter {
  return new PacketWriter(PlayOut.ChangeGameState)
    .writeUnsignedByte(3) // reason 3 = "change game mode"
    .writeFloat(gameMode);
}

// The Player List Item packet controls the tab list. Its first field is an
// "action" saying what kind of update follows.

export function playerListAdd(players: Player[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.PlayerListItem)
    .writeVarInt(0) // action 0 = add player
    .writeVarInt(players.length);

  for (const player of players) {
    packet
      .writeUUID(player.uuid)
      .writeString(player.username)
      .writeVarInt(0) // properties (skins come from here; offline mode has none)
      .writeVarInt(player.gameMode)
      .writeVarInt(0) // ping in ms
      .writeBoolean(false); // has a custom display name?
  }
  return packet;
}

export function playerListUpdateGameMode(player: Player): PacketWriter {
  return new PacketWriter(PlayOut.PlayerListItem)
    .writeVarInt(1) // action 1 = update game mode
    .writeVarInt(1)
    .writeUUID(player.uuid)
    .writeVarInt(player.gameMode);
}

export function playerListRemove(players: Player[]): PacketWriter {
  const packet = new PacketWriter(PlayOut.PlayerListItem)
    .writeVarInt(4) // action 4 = remove player
    .writeVarInt(players.length);

  for (const player of players) {
    packet.writeUUID(player.uuid);
  }
  return packet;
}

export function playDisconnect(reason: ChatComponent): PacketWriter {
  return new PacketWriter(PlayOut.Disconnect).writeChat(reason);
}
