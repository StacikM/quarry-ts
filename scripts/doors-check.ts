/**
 * Checks door placing, opening, closing and breaking through the real packet handler.
 * Run with:  npx tsx scripts/doors-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-doors-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { Block } = await import("../src/world/blocks");
  const { describeState, itemId, stateOf } = await import("../src/world/blockStates");
  const { PacketReader } = await import("../src/network/PacketReader");
  const { pendingLogin, readerFor } = await import("./support/fakeClient");

  type Pos = { x: number; y: number; z: number };
  const OAK_DOOR_ITEM = itemId("oak_door")!;
  const IRON_DOOR_ITEM = itemId("iron_door")!;
  const door = (props: Record<string, string | boolean> = {}, name = "oak_door"): number => stateOf(name, props);
  const isDoor = (state: number, name = "oak_door"): boolean => describeState(state).name === name;
  const prop = (state: number, key: string): string => describeState(state).properties[key];

  // A stand-in for a client connection that records everything the server sends it.
  const sent: InstanceType<typeof PacketWriter>[] = [];
  const connection = {
    player: null as unknown,
    address: "test",
    clientIp: "127.0.0.1",
    send: (packet: InstanceType<typeof PacketWriter>) => sent.push(packet),
    disconnect: () => {},
  };

  const server = new MinecraftServer();
  server.addPlayer(connection as never, pendingLogin("Alice", "00000000-0000-0000-0000-000000000001"));
  const player = connection.player as { yaw: number; gameMode: number; hotbar: number[]; heldSlot: number; awaitingTeleport: number | null };
  player.gameMode = GameMode.Creative;
  player.awaitingTeleport = null;
  sent.length = 0;

  const world = server.world;
  let sequence = 0;

  /** Right-click `clicked` on `face` while holding `item` (-1 for an empty hand). */
  function rightClick(clicked: Pos, face: number, item: number, cursor = { x: 0.5, y: 0.5, z: 0.5 }): void {
    player.hotbar[player.heldSlot] = item;
    const packet = new PacketWriter(PlayIn.UseItemOn)
      .writeVarInt(0)
      .writePosition(clicked)
      .writeVarInt(face)
      .writeFloat(cursor.x)
      .writeFloat(cursor.y)
      .writeFloat(cursor.z)
      .writeBoolean(false)
      .writeBoolean(false)
      .writeVarInt(++sequence);
    handlePlay(connection as never, PlayIn.UseItemOn, readerFor(packet));
  }

  function breakBlock(pos: Pos): void {
    const packet = new PacketWriter(PlayIn.PlayerAction).writeVarInt(0).writePosition(pos).writeByte(1).writeVarInt(++sequence);
    handlePlay(connection as never, PlayIn.PlayerAction, readerFor(packet));
  }

  /** Block changes the client was told about since `sent` was last cleared. */
  function blockChangesSent(): Array<{ pos: Pos; state: number }> {
    return sent
      .filter((p) => p.packetId === PlayOut.BlockUpdate)
      .map((p) => {
        const reader = new PacketReader(p.body());
        reader.readVarInt();
        const pos = reader.readPosition();
        return { pos, state: reader.readVarInt() };
      });
  }
  const acksSent = (): number => sent.filter((p) => p.packetId === PlayOut.BlockChangedAck).length;

  /** Flat free ground for a test: clears a 7x7x4 area above the surface and returns the block to click. */
  function arena(x: number, z: number): Pos {
    const surface = world.getSpawnHeight(x, z) - 1; // the top solid block
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      world.setBlock({ x: x + dx, y: surface, z: z + dz }, Block.Stone); // level floor
      for (let dy = 1; dy <= 4; dy++) world.setBlock({ x: x + dx, y: surface + dy, z: z + dz }, Block.Air);
    }
    return { x, y: surface, z };
  }
  const above = (p: Pos, n = 1): Pos => ({ x: p.x, y: p.y + n, z: p.z });

  // ---------------------------------------------------------------- place
  let base = arena(100, 100);
  player.yaw = 0; // looking south
  sent.length = 0;
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getState(above(base)), door({ facing: "south", half: "lower", hinge: "left" }), "lower half: facing south, closed");
  assert.strictEqual(world.getState(above(base, 2)), door({ facing: "south", half: "upper", hinge: "left" }), "upper half: same facing and hinge");
  assert.strictEqual(blockChangesSent().filter((c) => isDoor(c.state)).length, 2, "the client must be told about both halves");
  assert.strictEqual(acksSent(), 1, "and the placement is acknowledged");
  console.log("ok an oak door item places a two-block-tall door, the client is told and the action is acknowledged");

  // Facing follows where the player looks.
  const facings: Array<[number, string]> = [[0, "south"], [90, "west"], [180, "north"], [270, "east"], [-90, "east"], [45, "west"]];
  for (const [yaw, expected] of facings) {
    base = arena(120, 100);
    player.yaw = yaw;
    rightClick(base, 1, OAK_DOOR_ITEM);
    assert.strictEqual(prop(world.getState(above(base)), "facing"), expected, `yaw ${yaw}`);
  }
  console.log("ok the door faces the way the player looks (all four directions)");

  // ---------------------------------------------------------------- open and close
  base = arena(140, 100);
  player.yaw = 0;
  rightClick(base, 1, OAK_DOOR_ITEM);
  sent.length = 0;
  rightClick(above(base, 2), 2, -1); // click the UPPER half with an empty hand
  assert.strictEqual(prop(world.getState(above(base)), "open"), "true", "clicking the upper half opens the door");
  assert.strictEqual(prop(world.getState(above(base, 2)), "open"), "true", "and both halves are open");
  assert.strictEqual(blockChangesSent().filter((c) => isDoor(c.state) && prop(c.state, "open") === "true").length, 2, "the client must be told both halves opened");
  rightClick(above(base), 2, -1); // click the lower half
  assert.strictEqual(prop(world.getState(above(base)), "open"), "false", "clicking again closes it");
  rightClick(above(base), 2, OAK_DOOR_ITEM); // clicking with a door in hand still opens it instead of placing another
  assert.strictEqual(prop(world.getState(above(base)), "open"), "true");
  assert.strictEqual(world.getState(above(base, 3)), Block.Air, "no second door must be placed");
  console.log("ok right-clicking either half opens and closes the door");

  // Adventure mode can use doors but not place blocks; spectators can do neither.
  player.gameMode = GameMode.Adventure;
  rightClick(above(base), 2, -1);
  assert.strictEqual(prop(world.getState(above(base)), "open"), "false", "adventure players can open doors");
  const other = arena(160, 100);
  rightClick(other, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getState(above(other)), Block.Air, "adventure players cannot place doors");
  player.gameMode = GameMode.Spectator;
  rightClick(above(base), 2, -1);
  assert.strictEqual(prop(world.getState(above(base)), "open"), "false", "spectators cannot open doors");
  player.gameMode = GameMode.Creative;
  console.log("ok game modes: adventure opens doors, spectator does nothing");

  // ---------------------------------------------------------------- iron doors
  base = arena(180, 100);
  rightClick(base, 1, IRON_DOOR_ITEM);
  assert.ok(isDoor(world.getState(above(base)), "iron_door"));
  rightClick(above(base), 2, -1);
  assert.strictEqual(prop(world.getState(above(base)), "open"), "false", "iron doors do not open by hand");
  console.log("ok iron doors place but do not open by hand");

  // ---------------------------------------------------------------- breaking
  for (const half of [1, 2]) {
    base = arena(200, 100);
    rightClick(base, 1, OAK_DOOR_ITEM);
    sent.length = 0;
    breakBlock(above(base, half));
    assert.strictEqual(world.getState(above(base)), Block.Air, `breaking half ${half}: lower must go`);
    assert.strictEqual(world.getState(above(base, 2)), Block.Air, `breaking half ${half}: upper must go`);
    assert.strictEqual(blockChangesSent().filter((c) => c.state === Block.Air).length, 2, "the client must be told both halves vanished");
    assert.strictEqual(acksSent(), 1, "and the break is acknowledged");
  }
  console.log("ok breaking either half removes the whole door");

  // Breaking a block next to a door must not remove it.
  base = arena(220, 100);
  rightClick(base, 1, OAK_DOOR_ITEM);
  world.setBlock({ x: base.x + 1, y: base.y + 1, z: base.z }, Block.Stone);
  breakBlock({ x: base.x + 1, y: base.y + 1, z: base.z });
  assert.ok(isDoor(world.getState(above(base))), "a neighbouring block was broken but the door vanished");
  console.log("ok breaking a neighbouring block leaves the door alone");

  // ---------------------------------------------------------------- refusals
  base = arena(240, 100);
  sent.length = 0;
  rightClick(base, 2, OAK_DOOR_ITEM); // side face, not the top
  assert.strictEqual(world.getState({ x: base.x, y: base.y, z: base.z - 1 }), Block.Stone);
  assert.strictEqual(world.getState({ x: base.x, y: base.y + 1, z: base.z - 1 }), Block.Air, "doors only go on top of a block");
  assert.ok(blockChangesSent().length > 0, "a refused door must be undone on the client");
  assert.strictEqual(acksSent(), 1, "a refused placement is still acknowledged");

  world.setBlock(above(base, 2), Block.Stone); // no room for the upper half
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getState(above(base)), Block.Air, "a door needs two free blocks");
  world.setBlock(above(base, 2), Block.Air);

  const floating = { x: base.x + 2, y: base.y + 3, z: base.z };
  rightClick(floating, 1, OAK_DOOR_ITEM); // click on air high above the ground: nothing to stand on
  assert.strictEqual(world.getState(above(floating)), Block.Air);
  console.log("ok doors are refused on side faces, without room, or without support (and the client is corrected)");

  // Plugins can cancel a door placement just like any block.
  server.plugins.enable({
    name: "no-doors",
    version: "1",
    onEnable(api) {
      api.on("blockPlace", (event) => {
        if (isDoor(event.state)) event.cancelled = true;
      });
    },
  });
  sent.length = 0;
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getState(above(base)), Block.Air, "a cancelled door must not appear");
  assert.ok(blockChangesSent().length > 0, "the client must be corrected after a cancelled door");
  server.plugins.disable("no-doors");
  console.log("ok plugins can cancel door placement");

  // ---------------------------------------------------------------- hinge
  base = arena(260, 100);
  player.yaw = 0; // facing south: the right-hand side (clockwise) is west (-x)
  world.setBlock({ x: base.x - 1, y: base.y + 1, z: base.z }, Block.Stone);
  world.setBlock({ x: base.x - 1, y: base.y + 2, z: base.z }, Block.Stone);
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(prop(world.getState(above(base, 2)), "hinge"), "right", "with a wall on the right, the hinge goes on the right");

  base = arena(280, 100);
  rightClick(base, 1, OAK_DOOR_ITEM);
  const second = { x: base.x + 1, y: base.y, z: base.z }; // next door along, with the first on its right-hand side (west)
  rightClick(second, 1, OAK_DOOR_ITEM);
  assert.ok(isDoor(world.getState(above(second))));
  assert.strictEqual(prop(world.getState(above(second, 2)), "hinge"), "left", "next to another door on its right, the hinge stays left");

  // With no wall and no door, the side of the block that was clicked decides.
  base = arena(290, 100);
  rightClick(base, 1, OAK_DOOR_ITEM, { x: 0.2, y: 1, z: 0.5 });
  assert.strictEqual(prop(world.getState(above(base)), "hinge"), "right", "clicked the west half while facing south: hinge right");
  base = arena(295, 100);
  rightClick(base, 1, OAK_DOOR_ITEM, { x: 0.8, y: 1, z: 0.5 });
  assert.strictEqual(prop(world.getState(above(base)), "hinge"), "left", "clicked the east half while facing south: hinge left");
  console.log("ok hinge placement follows walls, neighbouring doors and the clicked side");

  // ---------------------------------------------------------------- shapes (vanilla cares about the block shape, not just light)
  const doorAt = (b: Pos): boolean => isDoor(world.getState(above(b)));

  // Stairs are not full cubes, so they must not pull the hinge towards them.
  base = arena(300, 100);
  player.yaw = 0;
  world.setBlock({ x: base.x - 1, y: base.y + 1, z: base.z }, stateOf("oak_stairs"));
  world.setBlock({ x: base.x - 1, y: base.y + 2, z: base.z }, stateOf("oak_stairs"));
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(prop(world.getState(above(base, 2)), "hinge"), "left", "stairs beside a door must not move the hinge");

  // What may hold a door up.
  const supports: Array<[string, number, boolean]> = [
    ["a full block", Block.Stone, true],
    ["glass", stateOf("glass"), true],
    ["a bottom slab", stateOf("oak_slab", { type: "bottom" }), false],
    ["a top slab", stateOf("oak_slab", { type: "top" }), true],
    ["a double slab", stateOf("oak_slab", { type: "double" }), true],
    ["a normal stair", stateOf("oak_stairs", { half: "bottom" }), false],
    ["an upside-down stair", stateOf("oak_stairs", { half: "top" }), true],
    ["a full-height snow layer", stateOf("snow", { layers: 8 }), true],
    ["farmland", stateOf("farmland"), false],
  ];
  for (const [name, state, allowed] of supports) {
    base = arena(320, 100);
    world.setBlock(base, state);
    rightClick(base, 1, OAK_DOOR_ITEM);
    assert.strictEqual(doorAt(base), allowed, "a door " + (allowed ? "should" : "should not") + " go on " + name);
  }
  console.log("ok doors need a sturdy top surface: full blocks, top slabs and upside-down stairs work; bottom slabs, stairs and farmland do not");

  // Top of the world: the lower half may be at y=254 (the upper half is then at 255), but not at 255.
  const column = { x: 340, y: 253, z: 100 };
  world.setBlock(column, Block.Stone);
  for (const y of [254, 255]) world.setBlock({ x: column.x, y, z: column.z }, Block.Air);
  rightClick(column, 1, OAK_DOOR_ITEM);
  assert.ok(isDoor(world.getState({ x: column.x, y: 254, z: column.z })), "lower half at y=254 is allowed");
  assert.ok(isDoor(world.getState({ x: column.x, y: 255, z: column.z })), "upper half at y=255");
  const roof = { x: 342, y: 254, z: 100 };
  world.setBlock(roof, Block.Stone);
  world.setBlock({ x: roof.x, y: 255, z: roof.z }, Block.Air);
  rightClick(roof, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getState({ x: roof.x, y: 255, z: roof.z }), Block.Air, "no door when the lower half would be at y=255");
  console.log("ok doors fit up to the top of the world, but no higher");

  // Other wood types and the 1.21 doors work the same way.
  for (const name of ["spruce_door", "bamboo_door", "cherry_door", "crimson_door", "copper_door"]) {
    base = arena(360, 100);
    rightClick(base, 1, itemId(name)!);
    assert.ok(isDoor(world.getState(above(base)), name), name + " is placed");
    rightClick(above(base), 2, -1);
    assert.strictEqual(prop(world.getState(above(base)), "open"), "true", name + " opens by hand");
  }
  console.log("ok every kind of door item places the matching door");

  // An empty hand or an unplaceable item just resyncs.
  base = arena(380, 100);
  sent.length = 0;
  rightClick(base, 1, -1);
  assert.strictEqual(world.getState(above(base)), Block.Air);
  assert.strictEqual(acksSent(), 1, "even an empty hand is acknowledged");

  console.log("ALL DOOR CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("DOOR CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
