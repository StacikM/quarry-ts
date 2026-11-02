import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import { PacketReader } from "../src/network/PacketReader";
import type { PacketWriter } from "../src/network/PacketWriter";
import * as packets from "../src/protocol/lobbyPackets";
import { Scoreboard } from "../src/game/Scoreboard";
import { handlePlay } from "../src/protocol/handlers/play";
import { PlayIn, PlayOut } from "../src/protocol/packetIds";
const { createDeserializer, createSerializer } = require("minecraft-protocol/src/transforms/serializer");
const version = "1.21.11";
const data = minecraftData(version);
assert.equal(data.version.version, 774);
const decoder = createDeserializer({ state: "play", isServer: false, version });
const encoder = createSerializer({ state: "play", isServer: false, version });
function decode(packet: PacketWriter, name: string): any {
  const body = packet.body();
  const result = decoder.parsePacketBuffer(body);
  assert.equal(result.metadata.size, body.length, `${name}: all wire bytes consumed`);
  assert.equal(result.data.name, name);
  return result.data.params;
}
const xp = decode(packets.experience(0.5, 42, 12345), "experience");
assert.deepEqual(xp, { experienceBar: 0.5, level: 42, totalExperience: 12345 });
for (const args of [[NaN, 0], [-1, 0], [1.1, 0], [0, -1], [0, 1.5], [0, 2 ** 31]]) assert.throws(() => packets.experience(args[0], args[1]));
for (const action of [0, 1, 2] as const) {
  const p = decode(packets.scoreboardObjective("hub", action, "世界"), "scoreboard_objective");
  assert.equal(p.action, action);
  if (action !== 1) { assert.equal(p.number_format, 0); assert.equal(p.displayText.value.text.value, "世界"); }
}
assert.equal(decode(packets.displayObjective("hub"), "scoreboard_display_objective").position, 1);
const row = decode(packets.scoreboardScore("hub", "line_0", 15, ""), "scoreboard_score");
assert.equal(row.number_format, 0); assert.equal(row.display_name.value.text.value, "");
assert.equal(decode(packets.resetScore("hub", "line_0"), "reset_score").objective_name, "hub");
const sent: PacketWriter[] = [];
const sidebar = new Scoreboard({ send: p => sent.push(p) });
sidebar.set("Hub", ["same", "same", ""]);
assert.equal(sent.length, 5);
sidebar.set("Hub", ["same", "same", ""]); assert.equal(sent.length, 5);
sidebar.set("Updated", ["same"]);
assert.equal(sent.length, 8);
assert.equal(sent[5].packetId, PlayOut.ScoreboardObjective);
for (const packet of sent.slice(6)) decode(packet, "reset_score");
sidebar.clear(); assert.equal(sent.length, 10); sidebar.clear(); assert.equal(sent.length, 10);
assert.throws(() => sidebar.set("bad", Array(16).fill("")));
const events: any[] = [];
const clicks: any[] = [];
const player: any = { inventory: { get: () => null }, containers: { click: (click: any) => clicks.push(click), close: (id: number) => clicks.push(id) }, gameMode: 2, heldSlot: 3, hotbar: Array(9).fill(-1), send: (p: PacketWriter) => sent.push(p),
    server: { plugins: { events: { emit(name: string, event: any) { events.push({ name, event }); event.cancelled = name !== 'inventoryClick'; return event; } } },
    npcs: { handleInteract() { throw new Error("Cancelled attack reached NPC dispatch"); } } } };
function inbound(name: string, params: any, expectedId: number): void {
  const body = encoder.createPacketBuffer({ name, params });
  const reader = new PacketReader(body);
  assert.equal(reader.readVarInt(), expectedId);
  handlePlay({ player } as any, expectedId, reader);
  assert.equal(reader.remaining, 0);
}
const payload = Buffer.from([0, 255, 128, 1]);
inbound("custom_payload", { channel: "moysmp:netcount", data: payload }, PlayIn.PluginMessage);
assert.equal(events[0].name, "pluginMessage"); assert.deepEqual(events[0].event.data, payload);
inbound("use_item", { hand: 0, sequence: 127, rotation: { x: 25, y: -15 } }, PlayIn.UseItem);
assert.equal(events[1].name, "itemUse"); assert.equal(events[1].event.slot, 3);
assert.equal(decode(sent.at(-1)!, "acknowledge_player_digging").sequenceId, 127);
inbound("use_entity", { target: 55, mouse: 1, sneaking: false }, PlayIn.Interact);
assert.equal(events[2].name, "playerAttack"); assert.equal(events[2].event.targetEntityId, 55);
inbound("window_click", { windowId: 130, stateId: 42, slot: 36, mouseButton: 1, mode: 0, changedSlots: [], cursorItem: null }, PlayIn.ContainerClick);
assert.deepEqual(clicks[0], { windowId: 130, stateId: 42, slot: 36, button: 1, mode: 0 });
inbound("close_window", { windowId: 130 }, PlayIn.ContainerClose); assert.equal(clicks[1], 130);
player.server.world = { getState: () => 0 };
inbound("block_place", { hand: 0, location: { x: 0, y: 64, z: 0 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: 128 }, PlayIn.UseItemOn);
assert.equal(events.at(-1).name, "itemUse");
assert.equal(decode(sent.at(-1)!, "acknowledge_player_digging").sequenceId, 128);
console.log("Migration protocol 774: scoreboard, XP, inbound payload, item use and cancelled attack wire checks passed");
