/**
 * Packet IDs for protocol 47 (Minecraft 1.8 - 1.8.9).
 *
 * The same number means different packets depending on the connection's
 * state, which is why they're grouped by state and direction.
 *   "In"  = client -> server (serverbound)
 *   "Out" = server -> client (clientbound)
 *
 * Full reference: the protocol pages on minecraft.wiki (formerly wiki.vg).
 * Use the 1.8.9 / protocol 47 version of the page; IDs changed in later versions.
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
} as const;

export const LoginOut = {
  Disconnect: 0x00,
  LoginSuccess: 0x02,
} as const;

export const PlayIn = {
  KeepAlive: 0x00,
  ChatMessage: 0x01,
  Player: 0x03, // just "on ground", sent when the player stands still
  PlayerPosition: 0x04,
  PlayerLook: 0x05,
  PlayerPositionAndLook: 0x06,
  PlayerDigging: 0x07,
  BlockPlacement: 0x08,
  Animation: 0x0a, // arm swing
} as const;

export const PlayOut = {
  KeepAlive: 0x00,
  JoinGame: 0x01,
  ChatMessage: 0x02,
  SpawnPosition: 0x05,
  PlayerPositionAndLook: 0x08,
  Animation: 0x0b,
  SpawnPlayer: 0x0c,
  DestroyEntities: 0x13,
  EntityTeleport: 0x18,
  EntityHeadLook: 0x19,
  ChunkData: 0x21,
  BlockChange: 0x23,
  ChangeGameState: 0x2b,
  PlayerListItem: 0x38,
  Disconnect: 0x40,
} as const;
