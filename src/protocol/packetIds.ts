/**
 * Packet IDs for protocol 774 (Minecraft 1.21.11).
 *
 * The same number means different packets depending on the connection's
 * state, which is why they're grouped by state and direction.
 *   "In"  = client -> server (serverbound)
 *   "Out" = server -> client (clientbound)
 *
 * scripts/protocol-check.ts compares every ID here with the table in
 * minecraft-data, so a wrong number cannot go unnoticed.
 */

export const HandshakeIn = {
  Handshake: 0x00,
} as const;

export const StatusIn = {
  Request: 0x00,
  Ping: 0x01,
} as const;

export const StatusOut = {
  Response: 0x00,
  Pong: 0x01,
} as const;

export const LoginIn = {
  LoginStart: 0x00,
  PluginResponse: 0x02,
  LoginAcknowledged: 0x03,
} as const;

export const LoginOut = {
  Disconnect: 0x00,
  LoginSuccess: 0x02,
  SetCompression: 0x03,
  PluginRequest: 0x04,
} as const;

export const ConfigIn = {
  ClientInformation: 0x00,
  PluginMessage: 0x02,
  FinishConfiguration: 0x03,
  KeepAlive: 0x04,
  KnownPacks: 0x07,
} as const;

export const ConfigOut = {
  PluginMessage: 0x01,
  Disconnect: 0x02,
  FinishConfiguration: 0x03,
  KeepAlive: 0x04,
  RegistryData: 0x07,
  FeatureFlags: 0x0c,
  Tags: 0x0d,
  KnownPacks: 0x0e,
} as const;

export const PlayIn = {
  TeleportConfirm: 0x00,
  ChatCommand: 0x06,
  ChatCommandSigned: 0x07,
  ChatMessage: 0x08,
  ChunkBatchReceived: 0x0a,
  ClientCommand: 0x0b,
  ClientInformation: 0x0d,
  KeepAlive: 0x1b,
  PlayerPosition: 0x1d,
  PlayerPositionAndLook: 0x1e,
  PlayerLook: 0x1f,
  PlayerStatusOnly: 0x20,
  PlayerAbilities: 0x27,
  PlayerAction: 0x28, // digging
  HeldItemChange: 0x34,
  SetCreativeSlot: 0x37,
  Swing: 0x3c,
  UseItemOn: 0x3f, // placing a block
} as const;

export const PlayOut = {
  SpawnEntity: 0x01,
  Animation: 0x02,
  BlockChangedAck: 0x04,
  BlockUpdate: 0x08,
  ChunkBatchFinished: 0x0b,
  ChunkBatchStart: 0x0c,
  PluginMessage: 0x18,
  ClearTitles: 0x0e,
  Commands: 0x10,
  Disconnect: 0x20,
  GameEvent: 0x26,
  KeepAlive: 0x2b,
  ChunkDataAndLight: 0x2c,
  Login: 0x30,
  PlayerAbilities: 0x3e,
  PlayerInfoRemove: 0x43,
  PlayerInfoUpdate: 0x44,
  PlayerPosition: 0x46,
  RemoveEntities: 0x4b,
  HeadRotation: 0x51,
  SetCenterChunk: 0x5c,
  SetDefaultSpawnPosition: 0x5f,
  SetTitleSubtitle: 0x6e,
  SetTime: 0x6f,
  SetTitleText: 0x70,
  SetTitleTimes: 0x71,
  SystemChat: 0x77,
  EntityPositionSync: 0x23,
  UnloadChunk: 0x25,
} as const;
