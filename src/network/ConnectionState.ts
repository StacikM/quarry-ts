/**
 * Every connection starts in Handshaking. The handshake packet then says
 * whether the client wants the server list info (Status) or to join (Login).
 * After login comes Configuration, where the server sends the game's
 * registries (biomes, damage types...), and then Play.
 */
export enum ConnectionState {
  Handshaking,
  Status,
  Login,
  Configuration,
  Play,
}
