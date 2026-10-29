/** Independent protocol-47 audit. Run: npx tsx scripts/protocol-check.ts */
import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import * as out from "../src/protocol/clientbound";
import * as ids from "../src/protocol/packetIds";
import { PacketReader } from "../src/network/PacketReader";
import { Chunk } from "../src/world/Chunk";
import { EventBus } from "../src/plugins/EventBus";
import { handlePlay } from "../src/protocol/handlers/play";
import type { PacketWriter } from "../src/network/PacketWriter";

// This decoder and encoder come from a separate implementation, not our PacketReader.
const { createDeserializer, createSerializer } = require("minecraft-protocol/src/transforms/serializer");
const data = minecraftData("1.8.9");
assert.equal(data.version.version, 47);
const clientDecoders: Record<string, any> = {};
const serverEncoders: Record<string, any> = {};
let outgoingChecks = 0, incomingChecks = 0;
function decoder(state: string): any {
  return clientDecoders[state] ??= createDeserializer({ state, isServer: false, version: "1.8.9", noErrorLogging: true });
}
function incoming(state: string, name: string, params: object): { id: number; reader: PacketReader; body: Buffer } {
  const encoder = serverEncoders[state] ??= createSerializer({ state, isServer: false, version: "1.8.9" });
  const body = encoder.createPacketBuffer({ name, params });
  const reader = new PacketReader(body);
  incomingChecks++;
  return { id: reader.readVarInt(), reader, body };
}
function decoded(state: string, packet: PacketWriter, name: string): any {
  const frame = packet.toBuffer();
  const external = decoder(state);
  const prefix = external.proto.read(frame, 0, "varint");
  assert.equal(prefix.value, frame.length - prefix.size, "outer length counts packet id and fields");
  assert(prefix.size <= 3, "uncompressed frame length uses at most three bytes");
  const parsed = external.parsePacketBuffer(frame.subarray(prefix.size));
  assert.equal(parsed.metadata.size, prefix.value, "independent decoder consumed every byte");
  assert.equal(parsed.data.name, name);
  outgoingChecks++;
  return parsed.data.params;
}
function checkIds(state: string, direction: string, table: Record<string, number>, names: Record<string, string>): void {
  const mapping = (data.protocol as any)[state][direction].types.packet[1][0].type[1].mappings;
  for (const [key, value] of Object.entries(table)) {
    const actual = Object.entries(mapping).find(([id]) => Number(id) === value)?.[1];
    assert.equal(actual, names[key], `${state}/${direction}/${key}`);
  }
}
checkIds("handshaking", "toServer", ids.HandshakeIn, { Handshake: "set_protocol" });
checkIds("status", "toServer", ids.StatusIn, { Request: "ping_start", Ping: "ping" });
checkIds("status", "toClient", ids.StatusOut, { Response: "server_info", Pong: "ping" });
checkIds("login", "toServer", ids.LoginIn, { LoginStart: "login_start" });
checkIds("login", "toClient", ids.LoginOut, { Disconnect: "disconnect", LoginSuccess: "success" });
checkIds("play", "toServer", ids.PlayIn, {
  KeepAlive: "keep_alive", ChatMessage: "chat", Player: "flying", PlayerPosition: "position", PlayerLook: "look",
  PlayerPositionAndLook: "position_look", PlayerDigging: "block_dig", BlockPlacement: "block_place", Animation: "arm_animation",
});
checkIds("play", "toClient", ids.PlayOut, {
  KeepAlive: "keep_alive", JoinGame: "login", ChatMessage: "chat", SpawnPosition: "spawn_position",
  PlayerPositionAndLook: "position", Animation: "animation", SpawnPlayer: "named_entity_spawn", DestroyEntities: "entity_destroy",
  EntityTeleport: "entity_teleport", EntityHeadLook: "entity_head_rotation", ChunkData: "map_chunk", BlockChange: "block_change",
  ChangeGameState: "game_state_change", PlayerListItem: "player_info", Disconnect: "kick_disconnect",
});

const player: any = {
  entityId: 257, uuid: "12345678-1234-4234-8234-123456789abc", username: "Audit", gameMode: 1,
  x: -3.03125, y: 73.125, z: 20.03125, yaw: 270, pitch: -90, onGround: true,
};
const component = { text: "Audit: héllo 世界", color: "gold" };
assert.deepEqual(JSON.parse(decoded("status", out.statusResponse({ description: component }), "server_info").response), { description: component });
for (const value of [0n, -1n, 0x123456789abcdefn]) {
  const result = decoded("status", out.pong(value), "ping");
  const externalBytes = createSerializer({ state: "status", isServer: true, version: "1.8.9" }).createPacketBuffer({ name: "ping", params: result });
  assert.equal(externalBytes.readBigInt64BE(1), value);
}
assert.deepEqual(JSON.parse(decoded("login", out.loginDisconnect(component), "disconnect").reason), component);
assert.deepEqual(decoded("login", out.loginSuccess(player.uuid, player.username), "success"), { uuid: player.uuid, username: player.username });
for (const id of [-1, 0, 127, 128, 2147483647]) assert.equal(decoded("play", out.keepAlive(id), "keep_alive").keepAliveId, id);
assert.deepEqual(decoded("play", out.joinGame(257, 1, 20), "login"), {
  entityId: 257, gameMode: 1, dimension: 0, difficulty: 0, maxPlayers: 20, levelType: "flat", reducedDebugInfo: false,
});
const chat = decoded("play", out.chatMessage(component), "chat");
assert.deepEqual(JSON.parse(chat.message), component); assert.equal(chat.position, 0);
for (const position of [{ x: -33554432, y: -2048, z: 33554431 }, { x: 12345, y: 255, z: -12345 }]) {
  assert.deepEqual(decoded("play", out.spawnPosition(position), "spawn_position").location, position);
  const encoded = incoming("play", "block_dig", { status: 2, location: position, face: 1 });
  assert.equal(encoded.reader.readVarInt(), 2);
  assert.deepEqual(encoded.reader.readPosition(), position);
  assert.equal(encoded.reader.readByte(), 1);
}
assert.deepEqual(decoded("play", out.playerPositionAndLook(-3.5, 72.25, 9, 270, -90), "position"), {
  x: -3.5, y: 72.25, z: 9, yaw: 270, pitch: -90, flags: 0,
});
assert.deepEqual(decoded("play", out.animation(257, 0), "animation"), { entityId: 257, animation: 0 });
const spawned = decoded("play", out.spawnPlayer(player), "named_entity_spawn");
assert.deepEqual(spawned, {
  entityId: 257, playerUUID: player.uuid, x: -97, y: 2340, z: 641, yaw: -64, pitch: -64,
  currentItem: 0, metadata: [{ type: 3, key: 6, value: 20 }],
});
assert.deepEqual(decoded("play", out.destroyEntities([1, 257]), "entity_destroy").entityIds, [1, 257]);
assert.deepEqual(decoded("play", out.entityTeleport(player), "entity_teleport"), {
  entityId: 257, x: -97, y: 2340, z: 641, yaw: -64, pitch: -64, onGround: true,
});
assert.deepEqual(decoded("play", out.entityHeadLook(player), "entity_head_rotation"), { entityId: 257, headYaw: -64 });
assert.deepEqual(decoded("play", out.blockChange({ x: -100, y: 255, z: 200 }, 35, 14), "block_change"), {
  location: { x: -100, y: 255, z: 200 }, type: 574,
});
assert.deepEqual(decoded("play", out.changeGameMode(3), "game_state_change"), { reason: 3, gameMode: 3 });
const added = decoded("play", out.playerListAdd([player]), "player_info");
assert.equal(added.action, "add_player");
assert.deepEqual(added.data, [{ uuid: player.uuid, name: "Audit", properties: [], gamemode: 1, ping: 0, displayName: undefined }]);
assert.deepEqual(decoded("play", out.playerListUpdateGameMode(player), "player_info"), {
  action: "update_game_mode", data: [{ uuid: player.uuid, gamemode: 1 }],
});
assert.deepEqual(decoded("play", out.playerListRemove([player]), "player_info"), { action: "remove_player", data: [{ uuid: player.uuid }] });
assert.deepEqual(JSON.parse(decoded("play", out.playDisconnect(component), "kick_disconnect").reason), component);

// Independently inspect 1.8's raw chunk buffer using Prismarine's 1.8 chunk/section layout.
const chunk = new Chunk(-3, 5);
const blocks = [[0, 0, 0, 1, 0], [1, 17, 2, 35, 14], [3, 113, 4, 18, 1], [15, 255, 15, 17, 2]];
for (const [x, y, z, id, meta] of blocks) chunk.setBlock(x, y, z, id, meta);
chunk.setBiome(3, 7, 12);
const map = decoded("play", out.chunkData(chunk), "map_chunk");
assert.equal(map.x, -3); assert.equal(map.z, 5); assert.equal(map.groundUp, true);
assert.equal(map.bitMap, (1 << 0) | (1 << 1) | (1 << 7) | (1 << 15));
const sections = [0, 1, 7, 15], bytes: Buffer = map.chunkData;
assert.equal(bytes.length, 4 * (8192 + 2048 + 2048) + 256);
for (const [x, y, z, id, meta] of blocks) {
  const index = sections.indexOf(Math.floor(y / 16)) * 4096 + (y % 16) * 256 + z * 16 + x;
  assert.equal(bytes.readUInt16LE(index * 2), id * 16 + meta);
}
assert(bytes.subarray(4 * 8192, 4 * (8192 + 2048)).every((byte) => byte === 0), "all block-light arrays follow all block-state arrays");
function sky(x: number, y: number, z: number): number {
  const index = sections.indexOf(Math.floor(y / 16)) * 4096 + (y % 16) * 256 + z * 16 + x;
  return (bytes[4 * (8192 + 2048) + Math.floor(index / 2)] >>> ((index % 2) * 4)) & 15;
}
assert.equal(sky(0, 1, 0), 15); assert.equal(sky(0, 0, 0), 0);
assert(sky(1, 16, 2) < 15, "opaque block blocks direct skylight; sideways propagation may remain");
assert.equal(sky(1, 18, 2), 15);
assert.equal(bytes[4 * 12288 + 7 * 16 + 3], 12);
assert.equal(bytes[4 * 12288], 1);
const unloaded = decoded("play", out.unloadChunk(-3, 5), "map_chunk");
assert.equal(unloaded.groundUp, true); assert.equal(unloaded.bitMap, 0); assert.equal(unloaded.chunkData.length, 0);

// Feed independently encoded serverbound fields to our reader.
const handshake = incoming("handshaking", "set_protocol", { protocolVersion: 47, serverHost: "localhost", serverPort: 65535, nextState: 2 });
assert.equal(handshake.id, ids.HandshakeIn.Handshake);
assert.equal(handshake.reader.readVarInt(), 47); assert.equal(handshake.reader.readString(), "localhost");
assert.equal(handshake.reader.readUnsignedShort(), 65535); assert.equal(handshake.reader.readVarInt(), 2);
const login = incoming("login", "login_start", { username: "Audit" });
assert.equal(login.id, ids.LoginIn.LoginStart); assert.equal(login.reader.readString(), "Audit");
assert.equal(incoming("status", "ping_start", {}).id, ids.StatusIn.Request);
const ping = incoming("status", "ping", { time: [0x1234567, 0x89abcdef | 0] });
assert.equal(ping.reader.readLong(), 0x123456789abcdefn);
const keepalive = incoming("play", "keep_alive", { keepAliveId: -1234567 });
assert.equal(keepalive.reader.readVarInt(), -1234567);
const incomingChat = incoming("play", "chat", { message: "héllo 世界" });
assert.equal(incomingChat.reader.readString(), "héllo 世界");
assert.equal(incoming("play", "arm_animation", {}).body.length, 1);
const flying = incoming("play", "flying", { onGround: true });
assert.equal(flying.reader.readBoolean(), true);
for (const name of ["position", "look", "position_look"]) {
  const fields: any = { x: -3.5, y: 72.25, z: 9, yaw: 270, pitch: -90, onGround: true };
  const encoded = incoming("play", name, fields);
  if (name !== "look") assert.deepEqual([encoded.reader.readDouble(), encoded.reader.readDouble(), encoded.reader.readDouble()], [-3.5, 72.25, 9]);
  if (name !== "position") assert.deepEqual([encoded.reader.readFloat(), encoded.reader.readFloat()], [270, -90]);
  assert.equal(encoded.reader.readBoolean(), true);
}
const placement = incoming("play", "block_place", {
  location: { x: -3, y: 64, z: 9 }, direction: 1,
  heldItem: { blockId: 35, itemCount: 64, itemDamage: 14, nbtData: undefined }, cursorX: 8, cursorY: 16, cursorZ: 8,
});
assert.deepEqual(placement.reader.readPosition(), { x: -3, y: 64, z: 9 }); assert.equal(placement.reader.readByte(), 1);
assert.deepEqual(placement.reader.readSlot(), { itemId: 35, count: 64, damage: 14 });
const emptyHand = incoming("play", "block_place", {
  location: { x: 0, y: 0, z: 0 }, direction: -1, heldItem: { blockId: -1 }, cursorX: 0, cursorY: 0, cursorZ: 0,
});
emptyHand.reader.readPosition();
assert.equal(emptyHand.reader.readByte(), -1);
assert.deepEqual(emptyHand.reader.readSlot(), { itemId: -1, count: 0, damage: 0 });
// Our reader deliberately stops before slot NBT; placement ignores NBT and cursor fields.

console.log(`Protocol 47: ${outgoingChecks} outgoing fixtures decoded independently; ${incomingChecks} incoming fixtures read; all declared packet IDs match.`);

// Explicit audit regressions: a valid non-minimal VarInt and an invalid negative string length.
const failures: string[] = [];
function regression(name: string, fn: () => void): void {
  try { fn(); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
regression("dig status is VarInt, including a two-byte encoding of zero", () => {
  const encoded = incoming("play", "block_dig", { status: 0, location: { x: 10, y: 64, z: 10 }, face: 1 });
  const nonMinimal = Buffer.concat([encoded.body.subarray(0, 1), Buffer.from([0x80, 0x00]), encoded.body.subarray(2)]);
  const independent = createDeserializer({ state: "play", isServer: true, version: "1.8.9", noErrorLogging: true }).parsePacketBuffer(nonMinimal);
  assert.equal(independent.data.params.status, 0);
  let broken = 0;
  const fakePlayer: any = { gameMode: 1, send() {}, server: {
    world: { getBlockId: () => 1, getBlockMetadata: () => 0, setBlock: () => broken++ },
    plugins: { events: new EventBus() }, broadcast() {},
  } };
  const reader = new PacketReader(nonMinimal);
  handlePlay({ player: fakePlayer } as any, reader.readVarInt(), reader);
  assert.equal(broken, 1, "a valid status-zero digging packet should break the target block in creative");
});
regression("negative string byte length is rejected before moving the cursor", () => {
  assert.throws(() => new PacketReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])).readString());
});
if (failures.length) { console.error(`Protocol audit found ${failures.length} regression(s).`); process.exitCode = 1; }
else console.log("Protocol audit regressions passed.");
