/**
 * Checks NPCs (fake players), middle-click pick block, /give and the inventory, through the real packet handler.
 * Run with:  npx tsx scripts/npc-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-npc-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PacketReader } = await import("../src/network/PacketReader");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { Block } = await import("../src/world/blocks");
  const { itemId, stateOf } = await import("../src/world/blockStates");
  const { config } = await import("../src/config");
  const { runCommand } = await import("../src/game/commands");
  const { PLAYER_ENTITY_TYPE, ARMOR_STAND_ENTITY_TYPE } = await import("../src/protocol/clientbound");
  const { pendingLogin, readerFor } = await import("./support/fakeClient");

  type Packet = InstanceType<typeof PacketWriter>;
  type Pos = { x: number; y: number; z: number };

  /** A stand-in for a client that records everything the server sends it. */
  function client(name: string, uuid: string): { conn: any; sent: Packet[]; player: any; joined: Packet[] } {
    const sent: Packet[] = [];
    const conn = {
      player: null as unknown,
      address: "test",
      clientIp: "127.0.0.1",
      send: (packet: Packet) => sent.push(packet),
      compressionThreshold: -1,
      sendFrame: () => {},
      disconnect: () => {},
    };
    server.addPlayer(conn as never, pendingLogin(name, uuid));
    const player = conn.player as any;
    player.awaitingTeleport = null;
    const joined = [...sent];
    sent.length = 0;
    return { conn, sent, player, joined };
  }
  const ids = (sent: Packet[]): number[] => sent.map((p) => p.packetId);

  const server = new MinecraftServer();
  const alice = client("Alice", "00000000-0000-0000-0000-000000000001");
  alice.player.gameMode = GameMode.Creative;
  const api = server.npcs.forOwner("test");
  const world = server.world;
  const events: Array<{ id: string; click: string; who: string; sneaking: boolean }> = [];
  server.plugins.events.on("test", "npcInteract", (event) => events.push({ id: event.npc.id, click: event.click, who: event.player.username, sneaking: event.sneaking }));

  const interact = (who: typeof alice, target: number, mouse: number, hand = 0, sneaking = false): void => {
    const packet = new PacketWriter(PlayIn.Interact).writeVarInt(target).writeVarInt(mouse);
    if (mouse === 2) packet.writeFloat(0.5).writeFloat(0.5).writeFloat(0.5);
    if (mouse !== 1) packet.writeVarInt(hand);
    packet.writeBoolean(sneaking);
    handlePlay(who.conn, PlayIn.Interact, readerFor(packet));
  };

  // ---------------------------------------------------------------- spawning
  const skin = { value: "dGV4dHVyZXM=", signature: "c2lnbmVk" };
  const shop = api.spawn({ id: "shop", position: { x: 10.5, y: 70, z: 10.5 }, yaw: 90, name: "§6Shop", skin })!;
  assert.ok(shop, "a valid definition spawns");
  assert.deepStrictEqual(
    ids(alice.sent),
    [PlayOut.PlayerInfoUpdate, PlayOut.SetPlayerTeam, PlayOut.SpawnEntity, PlayOut.SetEntityData, PlayOut.HeadRotation, PlayOut.SpawnEntity, PlayOut.SetEntityData],
    "tab entry (with the skin), team (hides the made-up name), the player entity, its data, its head, then the name stand and its data",
  );
  const spawns = alice.sent.filter((p) => p.packetId === PlayOut.SpawnEntity).map((p) => {
    const reader = new PacketReader(p.body());
    reader.readVarInt();
    const entityId = reader.readVarInt();
    reader.readUUID();
    return { entityId, type: reader.readVarInt(), x: reader.readDouble(), y: reader.readDouble(), z: reader.readDouble() };
  });
  assert.deepStrictEqual(spawns.map((s) => [s.entityId, s.type]), [[shop.entityId, PLAYER_ENTITY_TYPE], [shop.entityId + 1, ARMOR_STAND_ENTITY_TYPE]]);
  assert.strictEqual(spawns[1].y, 70 + 1.8, "the name stand floats where a name tag would be");
  assert.notStrictEqual(shop.entityId, alice.player.entityId, "an NPC has its own entity number");
  console.log("ok spawning an NPC sends the tab entry, team, entity, data and name stand, in that order");

  assert.strictEqual(api.spawn({ id: "shop", position: { x: 0, y: 0, z: 0 } }), null, "an id can only be used once");
  for (const bad of [
    { id: "", position: { x: 0, y: 0, z: 0 } },
    { id: "has space", position: { x: 0, y: 0, z: 0 } },
    { id: "ok", position: { x: NaN, y: 0, z: 0 } },
    { id: "ok", position: { x: 1e12, y: 0, z: 0 } },
    { id: "ok", position: { x: 0, y: 0, z: 0 }, name: "x".repeat(300) },
    { id: "ok", position: { x: 0, y: 0, z: 0 }, skin: { value: "" } },
    { id: "ok", position: { x: 0, y: 0, z: 0 }, yaw: Infinity },
  ]) assert.strictEqual(api.spawn(bad as never), null, `rejected: ${JSON.stringify(bad).slice(0, 60)}`);
  assert.strictEqual(api.list().length, 1);
  console.log("ok bad definitions are refused and nothing is spawned for them");

  // ---------------------------------------------------------------- joining later
  const bob = client("Bob", "00000000-0000-0000-0000-000000000002");
  // (client() clears what was sent, so look at the NPC through a second join)
  bob.player.gameMode = GameMode.Creative;
  bob.conn.player = null;
  server.npcs.showAllTo(bob.player);
  assert.strictEqual(bob.sent.filter((p) => p.packetId === PlayOut.SpawnEntity).length, 2, "someone who joins later gets the NPC too");
  bob.sent.length = 0;
  bob.conn.player = bob.player;
  console.log("ok players who join later see the NPCs");

  // ---------------------------------------------------------------- clicks
  interact(alice, shop.entityId, 1, 0, true);
  interact(alice, shop.entityId, 0, 0);
  interact(alice, shop.entityId + 1, 0, 0); // the name stand counts as the NPC
  interact(alice, shop.entityId, 2, 0); // "interact at" is followed by a plain interact: only one event per click
  interact(alice, shop.entityId, 0, 1); // off hand
  interact(alice, 99999, 1); // some other entity
  assert.deepStrictEqual(events, [
    { id: "shop", click: "left", who: "Alice", sneaking: true },
    { id: "shop", click: "right", who: "Alice", sneaking: false },
    { id: "shop", click: "right", who: "Alice", sneaking: false },
  ]);
  alice.player.gameMode = GameMode.Spectator;
  interact(alice, shop.entityId, 1);
  assert.strictEqual(events.length, 3, "spectators cannot click NPCs");
  alice.player.gameMode = GameMode.Creative;
  console.log("ok left and right clicks reach plugins once each, on the NPC or its name, not from the off hand or spectators");

  // ---------------------------------------------------------------- changes
  alice.sent.length = 0;
  shop.setName("§bBlue shop");
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.SetEntityData], "a new text only changes the name stand's data");
  alice.sent.length = 0;
  shop.setName("");
  assert.ok(ids(alice.sent).includes(PlayOut.RemoveEntities), "removing the text removes the name stand");
  assert.strictEqual(alice.sent.filter((p) => p.packetId === PlayOut.SpawnEntity).length, 1, "and the NPC itself is shown again, alone");
  alice.sent.length = 0;
  shop.setName("Back");
  assert.strictEqual(alice.sent.filter((p) => p.packetId === PlayOut.SpawnEntity).length, 2, "text again: NPC and name stand");
  alice.sent.length = 0;
  shop.setSkin({ value: "bmV3", signature: "c2ln" });
  assert.deepStrictEqual(ids(alice.sent).filter((id) => id === PlayOut.PlayerInfoUpdate || id === PlayOut.PlayerInfoRemove), [PlayOut.PlayerInfoRemove, PlayOut.PlayerInfoUpdate], "a new skin means the client forgets the old one first");
  alice.sent.length = 0;
  shop.teleport({ x: 1, y: 80, z: 2 }, 180, 10);
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.EntityPositionSync, PlayOut.HeadRotation, PlayOut.EntityPositionSync]);
  assert.deepStrictEqual(shop.definition.position, { x: 1, y: 80, z: 2 });
  assert.strictEqual(shop.definition.yaw, 180);
  shop.teleport({ x: NaN, y: 0, z: 0 });
  assert.strictEqual(shop.definition.position.x, 1, "a position that is not a number changes nothing");
  console.log("ok name, skin and position changes reach the clients the right way");

  // ---------------------------------------------------------------- looking at players
  const guard = api.spawn({ id: "guard", position: { x: 50.5, y: 70, z: 50.5 }, yaw: 0, lookAtPlayers: true })!;
  alice.player.x = 50.5; alice.player.y = 70; alice.player.z = 55.5; // 5 blocks south of it: it already faces south
  alice.sent.length = 0;
  server.npcs.tick(4);
  const turned = alice.sent.filter((p) => p.packetId === PlayOut.EntityPositionSync);
  assert.strictEqual(turned.length, 0, "an NPC that already looks at you does not send anything");
  alice.player.x = 55.5; alice.player.z = 50.5; // east of it
  server.npcs.tick(8);
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.EntityPositionSync, PlayOut.HeadRotation], "it turns when you walk around it");
  const body = new PacketReader(alice.sent[0].body());
  body.readVarInt(); body.readVarInt(); body.readDouble(); body.readDouble(); body.readDouble(); body.readDouble(); body.readDouble(); body.readDouble();
  assert.ok(Math.abs((((body.readFloat() % 360) + 360) % 360) - 270) < 0.01, "east of it is yaw 270 (-90 is the same direction)");
  alice.sent.length = 0;
  server.npcs.tick(9);
  assert.strictEqual(alice.sent.length, 0, "only every few ticks");
  alice.player.x = 500;
  server.npcs.tick(12);
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.EntityPositionSync, PlayOut.HeadRotation], "walking away turns it back the way it was placed");
  alice.sent.length = 0;
  server.npcs.tick(16);
  assert.strictEqual(alice.sent.length, 0, "and then it is quiet");
  guard.remove();
  console.log("ok an NPC that looks at players turns to them, only when close, and turns back");

  // ---------------------------------------------------------------- removal
  alice.sent.length = 0;
  shop.remove();
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.RemoveEntities, PlayOut.PlayerInfoRemove, PlayOut.SetPlayerTeam]);
  assert.strictEqual(api.get("shop"), undefined);
  events.length = 0;
  interact(alice, shop.entityId, 1);
  assert.strictEqual(events.length, 0, "a removed NPC cannot be clicked");
  assert.ok(api.spawn({ id: "shop", position: { x: 0, y: 70, z: 0 } }), "its id can be used again");
  api.spawn({ id: "a", position: { x: 0, y: 70, z: 0 } });
  server.npcs.removeOwned("test");
  assert.strictEqual(api.list().length, 0, "a plugin's NPCs go when it is disabled");
  console.log("ok removing NPCs cleans up the clients, and disabling a plugin removes its NPCs");

  // ---------------------------------------------------------------- pick block
  const spot: Pos = { x: 20, y: world.getSpawnHeight(20, 20), z: 20 };
  alice.player.x = 20.5; alice.player.y = spot.y; alice.player.z = 21.5;
  world.setBlock(spot, Block.Stone);
  world.setBlock({ x: 21, y: spot.y, z: 20 }, stateOf("oak_wall_sign", { facing: "south" }));
  world.setBlock({ x: 22, y: spot.y, z: 20 }, stateOf("wall_torch", { facing: "east" }));
  const pick = (who: typeof alice, pos: Pos): void => {
    const packet = new PacketWriter(PlayIn.PickItemFromBlock).writePosition(pos).writeBoolean(false);
    handlePlay(who.conn, PlayIn.PickItemFromBlock, readerFor(packet));
  };
  alice.player.heldSlot = 3;
  alice.sent.length = 0;
  pick(alice, spot);
  assert.strictEqual(alice.player.inventory.get(36 + 3)?.itemId, itemId("stone"), "the item goes into the selected slot when it is empty");
  assert.strictEqual(alice.player.hotbar[3], itemId("stone"), "and the hotbar the block placer reads");
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.ContainerSetSlot, PlayOut.SetHeldSlot]);
  pick(alice, { x: 21, y: spot.y, z: 20 });
  assert.strictEqual(alice.player.inventory.get(36 + 0)?.itemId, itemId("oak_sign"), "the selected slot is taken, so the first empty one is used (a wall sign gives the sign)");
  assert.strictEqual(alice.player.heldSlot, 0);
  pick(alice, { x: 22, y: spot.y, z: 20 });
  assert.strictEqual(alice.player.inventory.get(36 + 1)?.itemId, itemId("torch"), "a wall torch gives a torch");
  alice.player.heldSlot = 0;
  alice.sent.length = 0;
  pick(alice, spot);
  assert.strictEqual(alice.player.heldSlot, 3, "the item is already in the hotbar: that slot is selected");
  assert.deepStrictEqual(ids(alice.sent), [PlayOut.SetHeldSlot]);
  alice.sent.length = 0;
  pick(alice, { x: 20, y: spot.y + 5, z: 20 }); // air
  assert.strictEqual(alice.sent.length, 0, "air gives nothing");
  alice.player.x = 200;
  pick(alice, spot);
  assert.strictEqual(alice.sent.length, 0, "a block out of reach is ignored");
  alice.player.x = 20.5;
  alice.player.gameMode = GameMode.Survival;
  world.setBlock(spot, Block.Dirt);
  alice.sent.length = 0;
  pick(alice, spot);
  assert.strictEqual(alice.sent.length, 0, "in survival, a block you do not carry is not given to you");
  alice.player.gameMode = GameMode.Creative;
  console.log("ok middle click picks the block's item: into the hotbar, selecting what is there, nothing for air or from afar");

  // ---------------------------------------------------------------- the client changes its inventory (creative)
  const creativeSlot = (slot: number, id: number, count: number): void => {
    const packet = new PacketWriter(PlayIn.SetCreativeSlot).writeShort(slot).writeVarInt(count);
    if (count > 0) packet.writeVarInt(id).writeVarInt(0).writeVarInt(0);
    handlePlay(alice.conn, PlayIn.SetCreativeSlot, readerFor(packet));
  };
  alice.sent.length = 0;
  creativeSlot(40, itemId("diamond")!, 5);
  assert.deepStrictEqual(alice.player.inventory.get(40), { itemId: itemId("diamond"), count: 5 }, "any slot, not only the hotbar");
  creativeSlot(44, itemId("apple")!, 1);
  assert.strictEqual(alice.player.hotbar[8], itemId("apple"));
  creativeSlot(44, -1, 0);
  assert.strictEqual(alice.player.hotbar[8], -1, "an empty stack clears the slot");
  creativeSlot(41, 999999, 1);
  assert.strictEqual(alice.player.inventory.get(41), null, "an item number that does not exist is treated as nothing");
  creativeSlot(77, itemId("apple")!, 1); // not a slot
  creativeSlot(-1, itemId("apple")!, 1); // "dropped"
  assert.strictEqual(alice.sent.length, 0, "the client is not told what it just told us");
  alice.player.gameMode = GameMode.Survival;
  creativeSlot(42, itemId("apple")!, 1);
  assert.strictEqual(alice.player.inventory.get(42), null, "only creative players create items");
  alice.player.gameMode = GameMode.Creative;
  console.log("ok creative inventory changes are tracked, bad ones ignored");

  // ---------------------------------------------------------------- /give
  for (let slot = 9; slot <= 44; slot++) alice.player.setInventorySlot(slot, null, false);
  config.ops.push("Alice");
  alice.sent.length = 0;
  runCommand(alice.player, "give Alice diamond_sword");
  assert.strictEqual(alice.player.inventory.get(36)?.itemId, itemId("diamond_sword"), "into the first hotbar slot");
  assert.ok(ids(alice.sent).includes(PlayOut.ContainerSetSlot), "and the client is told");
  runCommand(alice.player, "give @s minecraft:diamond_sword 3");
  assert.strictEqual(alice.player.inventory.get(37)?.count, 1, "swords do not stack");
  assert.strictEqual(alice.player.inventory.get(38)?.count, 1);
  assert.strictEqual(alice.player.inventory.get(39)?.count, 1);
  runCommand(alice.player, "give Alice stone 150");
  assert.deepStrictEqual([40, 41, 42].map((slot) => alice.player.inventory.get(slot)?.count), [64, 64, 22], "a stack is 64");
  runCommand(alice.player, "give Alice stone 10");
  assert.strictEqual(alice.player.inventory.get(42)?.count, 32, "it tops up a stack that has room");
  runCommand(alice.player, "give Alice ender_pearl 20");
  assert.deepStrictEqual([43, 44].map((slot) => alice.player.inventory.get(slot)?.count), [16, 4], "ender pearls stack to 16");
  runCommand(alice.player, "give Alice dirt 64");
  assert.strictEqual(alice.player.inventory.get(9)?.itemId, itemId("dirt"), "when the hotbar is full the main part is used");
  const before = alice.sent.length;
  for (const bad of ["give", "give Alice", "give Alice notanitem", "give Alice stone 0", "give Alice stone abc", "give Alice stone 99999", "give Nobody stone"]) {
    runCommand(alice.player, bad);
  }
  assert.strictEqual(alice.sent.length - before, 7, "each mistake is answered with one message");
  const lastMessages = alice.sent.slice(before).filter((p) => p.packetId === PlayOut.SystemChat);
  assert.strictEqual(lastMessages.length, 7);
  for (let slot = 9; slot <= 44; slot++) alice.player.setInventorySlot(slot, { itemId: itemId("stone")!, count: 64 }, false);
  alice.sent.length = 0;
  runCommand(alice.player, "give Alice stone 5");
  assert.ok(!ids(alice.sent).includes(PlayOut.ContainerSetSlot), "a full inventory gets nothing");
  config.ops.pop();
  alice.sent.length = 0;
  runCommand(bob.player, "give Bob stone");
  assert.strictEqual(bob.player.inventory.get(36), null, "only operators can give");
  console.log("ok /give: stacks, top-ups, item limits, full inventories, mistakes and permission");

  // ---------------------------------------------------------------- operator level and the game mode switcher
  const statusOf = (sent: Packet[]): number[] => sent.filter((p) => p.packetId === PlayOut.EntityStatus).map((p) => {
    const reader = new PacketReader(p.body());
    reader.readVarInt();
    reader.readInt();
    return reader.readByte();
  });
  assert.deepStrictEqual(statusOf(bob.joined), [24], "joining tells the client its operator level (none)");
  const carol = client("Carol", "00000000-0000-0000-0000-000000000003");
  config.ops.push("Carol");
  carol.player.syncPermissionLevel();
  assert.deepStrictEqual(statusOf(carol.sent), [26], "an operator is told level 2, which the F3+F4 switcher needs");
  carol.sent.length = 0;
  carol.player.syncPermissionLevel();
  assert.strictEqual(carol.sent.length, 0, "and only once");
  config.ops.pop();
  carol.player.syncPermissionLevel();
  assert.deepStrictEqual(statusOf(carol.sent), [24], "/deop reaches the client too");
  const switchTo = (who: typeof alice, mode: number): void => {
    handlePlay(who.conn, PlayIn.ChangeGameMode, readerFor(new PacketWriter(PlayIn.ChangeGameMode).writeVarInt(mode)));
  };
  carol.player.gameMode = GameMode.Creative;
  switchTo(carol, GameMode.Spectator);
  assert.strictEqual(carol.player.gameMode, GameMode.Creative, "the switcher does not work for non-operators");
  config.ops.push("Carol");
  switchTo(carol, GameMode.Spectator);
  assert.strictEqual(carol.player.gameMode, GameMode.Spectator, "operators can switch");
  switchTo(carol, 9);
  assert.strictEqual(carol.player.gameMode, GameMode.Spectator, "a game mode that does not exist changes nothing");
  config.ops.pop();
  console.log("ok operators are told their level (F3+F4 needs it) and the game mode switcher obeys the same rule as /gamemode");

  console.log("ALL NPC CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("NPC CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
