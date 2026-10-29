/**
 * Every connection starts in Handshaking. The handshake packet then says
 * whether the client wants the server list info (Status) or to join (Login).
 * After a successful login we switch to Play.
 */
export enum ConnectionState {
  Handshaking,
  Status,
  Login,
  Play,
}
