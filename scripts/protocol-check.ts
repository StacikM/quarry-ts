/**
 * Independent protocol-774 (Minecraft 1.21.11) audit. Run: npx tsx scripts/protocol-check.ts
 *
 * Every packet we send is decoded by minecraft-protocol, which is a separate
 * implementation, and every packet we read is first encoded by it. Packet IDs are
 * compared with minecraft-data's table. (scripts/join-check.ts does the same over
 * a real connection, with the whole login.)
 */
import assert from "node:assert/strict";
import zlib from "node:zlib";
import minecraftData from "minecraft-data";
import * as out from "../src/protocol/clientbound";
import * as ids from "../src/protocol/packetIds";
import { PacketReader } from "../src/network/PacketReader";
import { PacketWriter } from "../src/network/PacketWriter";
import { frame, unframe } from "../src/network/framing";
import { encodeNetworkNbt } from "../src/protocol/nbt";
import { REGISTRY_KEYS } from "../src/protocol/registryKeys";
import { VANILLA_TAGS } from "../src/protocol/vanillaTags";
import { biomeId } from "../src/world/biomeIds";
import { itemId, stateOf } from "../src/world/blockStates";

const VERSION = "1.21.11";
const { createDeserializer, createSerializer } = require("minecraft-protocol/src/transforms/serializer");
const data = minecraftData(VERSION);
assert.equal(data.version.version, 774);

const clientDecoders: Record<string, any> = {};
const serverEncoders: Record<string, any> = {};
let outgoingChecks = 0, incomingChecks = 0;

function decoder(state: string): any {
  return clientDecoders[state] ??= createDeserializer({ state, isServer: false, version: VERSION, noErrorLogging: true });
}
/** Encodes a packet the way a real client would, and gives our reader the bytes. */
function incoming(state: string, name: string, params: object): { id: number; reader: PacketReader; body: Buffer } {
  const encoder = serverEncoders[state] ??= createSerializer({ state, isServer: false, version: VERSION });
  const body = encoder.createPacketBuffer({ name, params });
  const reader = new PacketReader(body);
  incomingChecks++;
  return { id: reader.readVarInt(), reader, body };
}
/** Decodes a packet we built with the independent decoder, and checks it used every byte. */
function decoded(state: string, packet: PacketWriter, name: string): any {
  const frameBytes = packet.toBuffer();
  const external = decoder(state);
  const prefix = external.proto.read(frameBytes, 0, "varint");
  assert.equal(prefix.value, frameBytes.length - prefix.size, "outer length counts packet id and fields");
  const parsed = external.parsePacketBuffer(frameBytes.subarray(prefix.size));
  assert.equal(parsed.metadata.size, prefix.value, `independent decoder consumed every byte of ${name}`);
  assert.equal(parsed.data.name, name);
  outgoingChecks++;
  return parsed.data.params;
}
function checkIds(state: string, direction: string, table: Record<string, number>, names: Record<string, string>): void {
  const mapping = (data.protocol as any)[state][direction].types.packet[1][0].type[1].mappings;
  for (const [key, value] of Object.entries(table)) {
    assert.ok(key in names, `${state}/${direction}/${key} has an expected name`);
    const actual = Object.entries(mapping).find(([id]) => Number(id) === value)?.[1];
    assert.equal(actual, names[key], `${state}/${direction}/${key}`);
  }
  for (const key of Object.keys(names)) assert.ok(key in table, `${state}/${direction}/${key} is declared`);
}

// ------------------------------------------------------------------ packet ids
checkIds("handshaking", "toServer", ids.HandshakeIn, { Handshake: "set_protocol" });
checkIds("status", "toServer", ids.StatusIn, { Request: "ping_start", Ping: "ping" });
checkIds("status", "toClient", ids.StatusOut, { Response: "server_info", Pong: "ping" });
checkIds("login", "toServer", ids.LoginIn, { LoginStart: "login_start", PluginResponse: "login_plugin_response", LoginAcknowledged: "login_acknowledged" });
checkIds("login", "toClient", ids.LoginOut, { Disconnect: "disconnect", LoginSuccess: "success", SetCompression: "compress", PluginRequest: "login_plugin_request" });
checkIds("configuration", "toServer", ids.ConfigIn, {
  ClientInformation: "settings", PluginMessage: "custom_payload", FinishConfiguration: "finish_configuration", KeepAlive: "keep_alive", KnownPacks: "select_known_packs",
});
checkIds("configuration", "toClient", ids.ConfigOut, {
  PluginMessage: "custom_payload", Disconnect: "disconnect", FinishConfiguration: "finish_configuration", KeepAlive: "keep_alive",
  RegistryData: "registry_data", FeatureFlags: "feature_flags", Tags: "tags", KnownPacks: "select_known_packs",
});
checkIds("play", "toServer", ids.PlayIn, {
  TeleportConfirm: "teleport_confirm", ChatCommand: "chat_command", ChatCommandSigned: "chat_command_signed", ChatMessage: "chat_message",
  ChunkBatchReceived: "chunk_batch_received", ClientCommand: "client_command", ClientInformation: "settings", KeepAlive: "keep_alive",
  PlayerPosition: "position", PlayerPositionAndLook: "position_look", PlayerLook: "look", PlayerStatusOnly: "flying", PlayerAbilities: "abilities",
  PlayerAction: "block_dig", HeldItemChange: "held_item_slot", SetCreativeSlot: "set_creative_slot", Swing: "arm_animation", UseItemOn: "block_place",
});
checkIds("play", "toClient", ids.PlayOut, {
  SpawnEntity: "spawn_entity", Animation: "animation", BlockChangedAck: "acknowledge_player_digging", BlockUpdate: "block_change",
  ChunkBatchFinished: "chunk_batch_finished", ChunkBatchStart: "chunk_batch_start", PluginMessage: "custom_payload", Commands: "declare_commands", Disconnect: "kick_disconnect",
  GameEvent: "game_state_change", KeepAlive: "keep_alive", ChunkDataAndLight: "map_chunk", Login: "login", PlayerAbilities: "abilities",
  PlayerInfoRemove: "player_remove", PlayerInfoUpdate: "player_info", PlayerPosition: "position", RemoveEntities: "entity_destroy",
  HeadRotation: "entity_head_rotation", SetCenterChunk: "update_view_position", SetDefaultSpawnPosition: "spawn_position", SetTime: "update_time",
  SystemChat: "system_chat", EntityPositionSync: "sync_entity_position", UnloadChunk: "unload_chunk",
});
assert.equal(data.entitiesByName.player.id, out.PLAYER_ENTITY_TYPE, "the player entity type number");

const player: any = {
  entityId: 257, uuid: "12345678-1234-4234-8234-123456789abc", username: "Audit", gameMode: 1,
  x: -3.03125, y: 73.125, z: 20.03125, yaw: 270, pitch: -90, onGround: true,
};
const component = { text: "Audit: héllo 世界", color: "gold" };
/** The independent decoder gives 64-bit numbers as [high, low] pairs. */
const long = (value: any): bigint => (Array.isArray(value) ? (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0) : BigInt(value));

/** What a text component looks like once the independent decoder has read the NBT. */
function simplify(value: any): any {
  if (value && typeof value === "object" && "type" in value && "value" in value) {
    const inner = value.value;
    if (value.type === "compound") return Object.fromEntries(Object.entries(inner).map(([key, entry]) => [key, simplify(entry)]));
    if (value.type === "list") return inner.value.map((entry: any) => simplify({ type: inner.type, value: entry }));
    return inner;
  }
  return value;
}

// ------------------------------------------------------------------ status, login
assert.deepEqual(JSON.parse(decoded("status", out.statusResponse({ description: component }), "server_info").response), { description: component });
for (const value of [0n, -1n, 0x123456789abcdefn]) {
  const result = decoded("status", out.pong(value), "ping");
  const externalBytes = createSerializer({ state: "status", isServer: true, version: VERSION }).createPacketBuffer({ name: "ping", params: result });
  assert.equal(externalBytes.readBigInt64BE(1), value);
}
assert.deepEqual(JSON.parse(decoded("login", out.loginDisconnect(component), "disconnect").reason), component);
assert.deepEqual(decoded("login", out.loginSuccess(player.uuid, player.username), "success"), { uuid: player.uuid, username: player.username, properties: [] });
assert.deepEqual(decoded("login", out.setCompression(256), "compress"), { threshold: 256 });
const request = decoded("login", out.velocityPlayerInfoRequest(12345, 1), "login_plugin_request");
assert.equal(request.messageId, 12345); assert.equal(request.channel, "velocity:player_info"); assert.deepEqual([...request.data], [1]);

const handshake = incoming("handshaking", "set_protocol", { protocolVersion: 774, serverHost: "localhost", serverPort: 65535, nextState: 2 });
assert.equal(handshake.id, ids.HandshakeIn.Handshake);
assert.equal(handshake.reader.readVarInt(), 774); assert.equal(handshake.reader.readString(), "localhost");
assert.equal(handshake.reader.readUnsignedShort(), 65535); assert.equal(handshake.reader.readVarInt(), 2);
const loginStart = incoming("login", "login_start", { username: "Audit", playerUUID: player.uuid });
assert.equal(loginStart.id, ids.LoginIn.LoginStart); assert.equal(loginStart.reader.readString(), "Audit"); assert.equal(loginStart.reader.readUUID(), player.uuid);
const pluginResponse = incoming("login", "login_plugin_response", { messageId: 300, data: Buffer.from([1, 2, 3]) });
assert.equal(pluginResponse.id, ids.LoginIn.PluginResponse);
assert.equal(pluginResponse.reader.readVarInt(), 300); assert.equal(pluginResponse.reader.readBoolean(), true); assert.deepEqual([...pluginResponse.reader.readRemaining()], [1, 2, 3]);
const noResponse = incoming("login", "login_plugin_response", { messageId: 300 });
noResponse.reader.readVarInt(); assert.equal(noResponse.reader.readBoolean(), false);
assert.equal(incoming("login", "login_acknowledged", {}).id, ids.LoginIn.LoginAcknowledged);
assert.equal(incoming("status", "ping_start", {}).id, ids.StatusIn.Request);
assert.equal(incoming("status", "ping", { time: [0x1234567, 0x89abcdef | 0] }).reader.readLong(), 0x123456789abcdefn);

// ------------------------------------------------------------------ configuration
assert.deepEqual(simplify(decoded("configuration", out.configDisconnect(component), "disconnect").reason), component);
const brand = decoded("configuration", out.serverBrand("Quarry.ts"), "custom_payload");
assert.equal(brand.channel, "minecraft:brand"); assert.equal(brand.data.subarray(1).toString(), "Quarry.ts");
assert.deepEqual(decoded("configuration", out.featureFlags(["minecraft:vanilla"]), "feature_flags").features, ["minecraft:vanilla"]);
assert.deepEqual(decoded("configuration", out.knownPacksRequest(VERSION), "select_known_packs").packs, [{ namespace: "minecraft", id: "core", version: VERSION }]);
assert.equal(decoded("configuration", out.finishConfiguration(), "finish_configuration") !== undefined, true);
let registries = 0;
for (const packet of out.allRegistryData()) {
  const registry = decoded("configuration", packet, "registry_data");
  assert.deepEqual(registry.entries.map((entry: any) => entry.key), REGISTRY_KEYS[registry.id], `registry ${registry.id}`);
  assert.ok(registry.entries.every((entry: any) => entry.value === undefined), "entries carry no data of their own");
  registries++;
}
assert.equal(registries, Object.keys((data.loginPacket as any).dimensionCodec).length, "every registry minecraft-data knows is sent");
const sentTags = decoded("configuration", out.tagsPacket(), "tags").tags;
assert.deepEqual(sentTags.map((entry: any) => entry.tagType), Object.keys(VANILLA_TAGS));
const tagsOf = (registry: string, name: string): number[] => sentTags.find((entry: any) => entry.tagType === registry).tags.find((tag: any) => tag.tagName === name).entries;
assert.deepEqual(tagsOf("minecraft:timeline", "minecraft:in_overworld"), [0, 1, 2, 3], "all four timelines apply in the overworld");
assert.ok(tagsOf("minecraft:enchantment", "minecraft:exclusive_set/armor").length === 4, "four armour enchantments exclude each other");
assert.ok(tagsOf("minecraft:fluid", "minecraft:water").length === 2, "water and flowing water");
assert.ok(tagsOf("minecraft:block", "minecraft:climbable").includes(data.blocksByName.ladder.id), "ladders climb");
assert.ok(tagsOf("minecraft:item", "minecraft:swords").includes(data.itemsByName.diamond_sword.id), "swords are swords");
const knownPacks = incoming("configuration", "select_known_packs", { packs: [{ namespace: "minecraft", id: "core", version: VERSION }] });
assert.equal(knownPacks.id, ids.ConfigIn.KnownPacks); assert.equal(knownPacks.reader.readVarInt(), 1);
assert.deepEqual([knownPacks.reader.readString(), knownPacks.reader.readString(), knownPacks.reader.readString()], ["minecraft", "core", VERSION]);
const settings = incoming("configuration", "settings", {
  locale: "en_us", viewDistance: 12, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true, particleStatus: "all",
});
assert.equal(settings.id, ids.ConfigIn.ClientInformation); assert.equal(settings.reader.readString(), "en_us"); assert.equal(settings.reader.readByte(), 12);

// ------------------------------------------------------------------ play, clientbound
for (const id of [-1, 0, 127, 128, 2147483647]) assert.equal(long(decoded("play", out.keepAlive(id), "keep_alive").keepAliveId), BigInt(id));
const login = decoded("play", out.joinGame(257, 1, 20, 6), "login");
assert.equal(login.entityId, 257); assert.equal(login.maxPlayers, 20); assert.equal(login.viewDistance, 6); assert.equal(login.simulationDistance, 6);
assert.deepEqual(login.worldNames, ["minecraft:overworld"]); assert.equal(login.worldState.gamemode, "creative"); assert.equal(login.worldState.name, "minecraft:overworld");
assert.equal(login.worldState.dimension, REGISTRY_KEYS["minecraft:dimension_type"].indexOf("minecraft:overworld"));
assert.equal(login.worldState.seaLevel, 63); assert.equal(login.enforcesSecureChat, false);
assert.equal(decoded("play", out.gameEvent(out.GameEvent.LevelChunksLoadStart, 0), "game_state_change").reason, "level_chunks_load_start");
assert.deepEqual(decoded("play", out.changeGameMode(3), "game_state_change"), { reason: "change_game_mode", gameMode: 3 });
const chat = decoded("play", out.systemChat(component), "system_chat");
assert.deepEqual(simplify(chat.content), component); assert.equal(chat.isActionBar, false);
assert.equal(decoded("play", out.systemChat({ text: "x" }, true), "system_chat").isActionBar, true);
for (const position of [{ x: -33554432, y: -2048, z: 33554431 }, { x: 12345, y: 255, z: -12345 }]) {
  const spawn = decoded("play", out.spawnPosition(position), "spawn_position");
  assert.deepEqual(spawn.globalPos.location, position); assert.equal(spawn.globalPos.dimensionName, "minecraft:overworld");
  assert.deepEqual(decoded("play", out.blockChange(position, 1234), "block_change"), { location: position, type: 1234 });
  const dig = incoming("play", "block_dig", { status: 2, location: position, face: 1, sequence: 77 });
  assert.equal(dig.id, ids.PlayIn.PlayerAction);
  assert.equal(dig.reader.readVarInt(), 2); assert.deepEqual(dig.reader.readPosition(), position); assert.equal(dig.reader.readByte(), 1); assert.equal(dig.reader.readVarInt(), 77);
}
assert.equal(decoded("play", out.blockChangedAck(300), "acknowledge_player_digging").sequenceId, 300);
const moved = decoded("play", out.playerPosition(9, -3.5, 72.25, 9, 270, -90), "position");
assert.equal(moved.teleportId, 9); assert.deepEqual([moved.x, moved.y, moved.z, moved.yaw, moved.pitch], [-3.5, 72.25, 9, 270, -90]);
assert.deepEqual(decoded("play", out.setCenterChunk(-7, 12), "update_view_position"), { chunkX: -7, chunkZ: 12 });
assert.deepEqual(decoded("play", out.animation(257, 0), "animation"), { entityId: 257, animation: 0 });
const spawned = decoded("play", out.spawnPlayer(player), "spawn_entity");
assert.equal(spawned.entityId, 257); assert.equal(spawned.objectUUID, player.uuid); assert.equal(spawned.type, out.PLAYER_ENTITY_TYPE);
assert.deepEqual([spawned.x, spawned.y, spawned.z], [player.x, player.y, player.z]); assert.equal(spawned.yaw, -64); assert.equal(spawned.pitch, -64); assert.equal(spawned.headPitch, -64);
assert.deepEqual(decoded("play", out.destroyEntities([1, 257]), "entity_destroy").entityIds, [1, 257]);
const synced = decoded("play", out.entityTeleport(player), "sync_entity_position");
assert.deepEqual([synced.entityId, synced.x, synced.y, synced.z, synced.yaw, synced.pitch, synced.onGround], [257, player.x, player.y, player.z, 270, -90, true]);
assert.deepEqual(decoded("play", out.entityHeadLook(player), "entity_head_rotation"), { entityId: 257, headYaw: -64 });
const abilities = (mode: number, flying?: boolean): any => decoded("play", out.playerAbilities(mode, flying), "abilities");
assert.equal(abilities(1).flags, 1 | 4 | 8); assert.equal(abilities(1, true).flags, 1 | 2 | 4 | 8); assert.equal(abilities(0).flags, 0); assert.equal(abilities(3).flags, 1 | 4);
const time = decoded("play", out.timeUpdate(5, 6000, false), "update_time");
assert.deepEqual([long(time.age), long(time.time), time.tickDayTime], [5n, 6000n, false]);
assert.equal(decoded("play", out.chunkBatchStart(), "chunk_batch_start") !== undefined, true);
assert.deepEqual(decoded("play", out.chunkBatchFinished(3), "chunk_batch_finished"), { batchSize: 3 });
const unload = decoded("play", out.unloadChunk(-3, 5), "unload_chunk");
assert.deepEqual([unload.chunkX, unload.chunkZ], [-3, 5]);

const added = decoded("play", out.playerListAdd([player]), "player_info");
assert.equal(added.action._value, 0x1d);
assert.deepEqual({ ...added.action, _value: undefined }, { _value: undefined, add_player: true, initialize_chat: false, update_game_mode: true, update_listed: true, update_latency: true, update_display_name: false, update_hat: false, update_list_order: false });
assert.equal(added.data[0].uuid, player.uuid); assert.equal(added.data[0].player.name, "Audit"); assert.deepEqual(added.data[0].player.properties, []);
assert.equal(added.data[0].gamemode, 1); assert.equal(added.data[0].latency, 0);
const gameModeOnly = decoded("play", out.playerListUpdateGameMode(player), "player_info");
assert.equal(gameModeOnly.action.update_game_mode, true); assert.equal(gameModeOnly.action.add_player, false); assert.equal(gameModeOnly.data[0].gamemode, 1);
assert.deepEqual(decoded("play", out.playerListRemove([player]), "player_remove").players, [player.uuid]);
assert.deepEqual(simplify(decoded("play", out.playDisconnect(component), "kick_disconnect").reason), component);

const tree = decoded("play", out.commandTree(["help", "tp"]), "declare_commands");
assert.equal(tree.nodes.length, 5); assert.equal(tree.rootIndex, 0);
assert.deepEqual(tree.nodes[0].children, [1, 3]);
assert.equal(tree.nodes[1].extraNodeData.name, "help"); assert.deepEqual(tree.nodes[1].children, [2]);
assert.equal(tree.nodes[2].flags.command_node_type, 2);

// ------------------------------------------------------------------ chunks
{
  const { Chunk } = require("../src/world/Chunk");
  const { computeLight } = require("../src/world/lighting");
  const chunk = new Chunk(-3, 5);
  const stone = stateOf("stone"), glowstone = stateOf("glowstone"), oak = stateOf("oak_planks");
  const blocks: Array<[number, number, number, number]> = [[0, 0, 0, stone], [1, 17, 2, glowstone], [3, 113, 4, oak], [15, 255, 15, stone]];
  for (const [x, y, z, state] of blocks) chunk.setBlock(x, y, z, state);
  chunk.setBiome(2, 2, biomeId("desert"));
  // a section with many kinds of block, to force the direct (no palette) format
  for (let i = 0; i < 400; i++) chunk.setBlock(i & 15, 32 + (i >> 8), (i >> 4) & 15, 1 + (i * 7) % 3000);

  const packet = out.chunkData(chunk, chunk.light ?? computeLight(chunk.getRawBlocks(), chunk.getHeightMap()));
  const map = decoded("play", packet, "map_chunk");
  assert.equal(map.x, -3); assert.equal(map.z, 5);
  assert.deepEqual(map.heightmaps.map((entry: any) => entry.type), ["world_surface", "motion_blocking"]);
  assert.equal(map.heightmaps[0].data.length, 37, "256 heights of 9 bits, 7 to a long");
  assert.equal(map.blockEntities.length, 0);
  assert.equal(map.skyLight.length, 21); assert.equal(map.blockLight.length, 16);
  assert.ok(map.skyLight.every((array: Buffer) => array.length === 2048));
  assert.equal(map.skyLightMask.length, 1);
  assert.equal(long(map.skyLightMask[0]), ((1n << 26n) - 1n) & ~0b11111n, "sky light for the 16 stored sections and those above");
  assert.equal(long(map.blockLightMask[0]), 0xffffn << 5n, "block light only for the stored sections");
  assert.equal(long(map.emptySkyLightMask[0]), 0b11111n);
  assert.equal(long(map.emptyBlockLightMask[0]), 0b11111n | (0b11111n << 21n));
  assert.ok(map.skyLight.slice(16).every((array: Buffer) => array.every((byte) => byte === 0xff)), "open sky above the build limit");

  // Read the sections back with a second, deliberately simple, reader.
  const bytes: Buffer = map.chunkData;
  let at = 0;
  const varInt = (): number => { let value = 0; for (let shift = 0; ; shift += 7) { const byte = bytes[at++]; value |= (byte & 0x7f) << shift; if (!(byte & 0x80)) return value; } };
  const container = (size: number, maxPalette: number, direct: number): number[] => {
    const bits = bytes[at++];
    if (bits === 0) return new Array(size).fill(varInt());
    const palette = bits <= maxPalette ? Array.from({ length: varInt() }, varInt) : null;
    const perLong = Math.floor(64 / bits), count = Math.ceil(size / perLong); // no length is sent
    assert.equal(bits, palette ? bits : direct);
    const values: number[] = [];
    for (let i = 0; i < size; i++) {
      const long = bytes.readBigUInt64BE(at + Math.floor(i / perLong) * 8);
      const entry = Number((long >> BigInt((i % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
      values.push(palette ? palette[entry] : entry);
    }
    at += count * 8;
    return values;
  };
  const sections: number[][] = [], biomes: number[][] = [];
  const kinds = new Set<number>();
  for (let s = 0; s < 24; s++) {
    at += 2;
    const before = at;
    sections.push(container(4096, 8, 15));
    kinds.add(bytes[before]);
    biomes.push(container(64, 3, 7));
  }
  assert.equal(at, bytes.length);
  for (const [x, y, z, state] of blocks) assert.equal(sections[4 + (y >> 4)][((y & 15) << 8) | (z << 4) | x], state);
  assert.ok(kinds.has(0), "uniform sections use the single-value form");
  assert.ok([...kinds].some((bits) => bits >= 4 && bits <= 8), "a mixed section uses a palette");
  assert.ok(kinds.has(15), "a section with too many kinds of block uses the direct form");
  assert.equal(biomes[4][(0 << 4) | (0 << 2) | 0], biomeId("desert"), "the biome of the middle column of the first cell");
  assert.equal(biomes[4][(0 << 4) | (0 << 2) | 1], biomeId("plains"));
}

// ------------------------------------------------------------------ play, serverbound
{
  const keepalive = incoming("play", "keep_alive", { keepAliveId: -1234567n });
  assert.equal(keepalive.id, ids.PlayIn.KeepAlive); assert.equal(keepalive.reader.readLong(), -1234567n);
  assert.equal(incoming("play", "teleport_confirm", { teleportId: 77 }).reader.readVarInt(), 77);
  const message = incoming("play", "chat_message", { message: "héllo 世界", timestamp: 1n, salt: 2n, signature: undefined, offset: 0, acknowledged: Buffer.alloc(3), checksum: 0 });
  assert.equal(message.id, ids.PlayIn.ChatMessage); assert.equal(message.reader.readString(), "héllo 世界");
  const command = incoming("play", "chat_command", { command: "gamemode c" });
  assert.equal(command.id, ids.PlayIn.ChatCommand); assert.equal(command.reader.readString(), "gamemode c");
  const signedCommand = incoming("play", "chat_command_signed", { command: "say hi", timestamp: 1n, salt: 2n, argumentSignatures: [], messageCount: 0, acknowledged: Buffer.alloc(3), checksum: 0 });
  assert.equal(signedCommand.id, ids.PlayIn.ChatCommandSigned); assert.equal(signedCommand.reader.readString(), "say hi");
  assert.equal(incoming("play", "arm_animation", { hand: 0 }).id, ids.PlayIn.Swing);

  const flags = { onGround: true, hasHorizontalCollision: false };
  const flying = incoming("play", "flying", { flags });
  assert.equal(flying.id, ids.PlayIn.PlayerStatusOnly); assert.equal(flying.reader.readUnsignedByte() & 1, 1);
  for (const [name, id] of [["position", ids.PlayIn.PlayerPosition], ["look", ids.PlayIn.PlayerLook], ["position_look", ids.PlayIn.PlayerPositionAndLook]] as const) {
    const encoded = incoming("play", name, { x: -3.5, y: 72.25, z: 9, yaw: 270, pitch: -90, flags });
    assert.equal(encoded.id, id);
    if (name !== "look") assert.deepEqual([encoded.reader.readDouble(), encoded.reader.readDouble(), encoded.reader.readDouble()], [-3.5, 72.25, 9]);
    if (name !== "position") assert.deepEqual([encoded.reader.readFloat(), encoded.reader.readFloat()], [270, -90]);
    assert.equal(encoded.reader.readUnsignedByte() & 1, 1);
  }

  const place = incoming("play", "block_place", {
    hand: 0, location: { x: -3, y: 64, z: 9 }, direction: 1, cursorX: 0.25, cursorY: 1, cursorZ: 0.75, insideBlock: false, worldBorderHit: false, sequence: 5,
  });
  assert.equal(place.id, ids.PlayIn.UseItemOn);
  assert.equal(place.reader.readVarInt(), 0); assert.deepEqual(place.reader.readPosition(), { x: -3, y: 64, z: 9 }); assert.equal(place.reader.readVarInt(), 1);
  assert.deepEqual([place.reader.readFloat(), place.reader.readFloat(), place.reader.readFloat()], [0.25, 1, 0.75]);
  assert.equal(place.reader.readBoolean(), false); assert.equal(place.reader.readBoolean(), false); assert.equal(place.reader.readVarInt(), 5);

  const stone = itemId("stone")!;
  const creative = incoming("play", "set_creative_slot", { slot: 36, item: { itemCount: 64, itemId: stone, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } });
  assert.equal(creative.id, ids.PlayIn.SetCreativeSlot); assert.equal(creative.reader.readShort(), 36);
  assert.deepEqual(creative.reader.readSlot(), { itemId: stone, count: 64 });
  const emptySlot = incoming("play", "set_creative_slot", { slot: 37, item: { itemCount: 0 } });
  emptySlot.reader.readShort(); assert.deepEqual(emptySlot.reader.readSlot(), { itemId: -1, count: 0 });
  assert.equal(incoming("play", "held_item_slot", { slotId: 4 }).reader.readShort(), 4);
  assert.equal(incoming("play", "abilities", { flags: 2 }).id, ids.PlayIn.PlayerAbilities);
}

// ------------------------------------------------------------------ nbt, compression, reader
{
  assert.deepEqual(simplify(createDeserializer({ state: "play", isServer: false, version: VERSION, noErrorLogging: true })
    .parsePacketBuffer(new PacketWriter(ids.PlayOut.SystemChat).writeTextComponent({ text: "a", extra: [{ text: "b", bold: true }, { text: "c" }] }).writeBoolean(false).body()).data.params.content),
    { text: "a", extra: [{ text: "b", bold: 1 }, { text: "c" }] });
  assert.equal(encodeNetworkNbt("hi")[0], 8, "a plain string is a String tag");
  assert.throws(() => encodeNetworkNbt(["a", 1]), /one kind of value/);
  // Java's modified UTF-8: NUL is two bytes and an emoji is two three-byte halves.
  assert.deepEqual([...encodeNetworkNbt("\u0000")].slice(3), [0xc0, 0x80]);
  assert.equal(encodeNetworkNbt("😀").length, 3 + 6);

  const small = new PacketWriter(0x21).writeString("tiny").body();
  const big = new PacketWriter(0x21).writeBytes(Buffer.alloc(5000, 7)).body();
  const lengthOf = (framed: Buffer): { size: number; length: number } => { const r = new PacketReader(framed); const length = r.readVarInt(); return { size: framed.length - r.remaining, length }; };
  for (const body of [small, big]) {
    assert.deepEqual(unframe(frame(body, -1).subarray(lengthOf(frame(body, -1)).size), -1, 1 << 20), body);
    const framed = frame(body, 256);
    const header = lengthOf(framed);
    assert.equal(header.length, framed.length - header.size, "the length counts everything after it");
    assert.deepEqual(unframe(framed.subarray(header.size), 256, 1 << 20), body);
  }
  assert.ok(frame(big, 256).length < 100, "big packets are compressed");
  assert.equal(frame(small, 256)[frame(small, 256).length - small.length - 1], 0, "small packets are sent as they are, with data length 0");
  // A packet that unpacks to more than it claims, or more than allowed, is refused.
  const bomb = Buffer.concat([Buffer.from([0x83, 0x20]), zlib.deflateSync(Buffer.alloc(4096))]);
  assert.throws(() => unframe(bomb, 256, 1 << 20));
  assert.throws(() => unframe(Buffer.concat([Buffer.from([0x80, 0x80, 0x80, 0x10]), zlib.deflateSync(Buffer.alloc(10))]), 256, 1 << 20), /too big/);

  assert.throws(() => new PacketReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])).readString(), "negative string length");
  assert.throws(() => new PacketReader(Buffer.from([0x05, 0x61])).readString(), "string longer than the packet");
  assert.deepEqual(new PacketReader(new PacketWriter(0).writePosition({ x: -1, y: -64, z: 1 }).body().subarray(1)).readPosition(), { x: -1, y: -64, z: 1 });
}

console.log(`Protocol 774: ${outgoingChecks} outgoing fixtures decoded independently; ${incomingChecks} incoming fixtures read; all declared packet IDs match.`);
