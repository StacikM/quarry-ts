/**
 * Checks that plants, torches and other blocks that need support break when it goes away,
 * and cannot be placed where they could not stay.
 * Run with:  npx tsx scripts/support-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-support-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { Block } = await import("../src/world/blocks");
  const { describeState, itemId, stateOf, defaultState } = await import("../src/world/blockStates");
  const { PacketReader } = await import("../src/network/PacketReader");
  const { pendingLogin, readerFor } = await import("./support/fakeClient");

  type Pos = { x: number; y: number; z: number };
  const sent: InstanceType<typeof PacketWriter>[] = [];
  const connection = {
    player: null as unknown,
    address: "test",
    clientIp: "127.0.0.1",
    send: (packet: InstanceType<typeof PacketWriter>) => sent.push(packet),
    compressionThreshold: -1,
    sendFrame: () => {},
    disconnect: () => {},
  };
  const server = new MinecraftServer();
  server.addPlayer(connection as never, pendingLogin("Alice", "00000000-0000-0000-0000-000000000001"));
  const player = connection.player as { yaw: number; gameMode: number; hotbar: number[]; heldSlot: number; awaitingTeleport: number | null };
  player.gameMode = GameMode.Creative;
  player.awaitingTeleport = null;

  const world = server.world;
  let sequence = 0;
  const name = (pos: Pos): string => describeState(world.getState(pos)).name;
  const above = (p: Pos, n = 1): Pos => ({ x: p.x, y: p.y + n, z: p.z });
  const set = (pos: Pos, state: number): void => world.setBlock(pos, state);

  function rightClick(clicked: Pos, face: number, item: string): void {
    player.hotbar[player.heldSlot] = itemId(item)!;
    const packet = new PacketWriter(PlayIn.UseItemOn)
      .writeVarInt(0).writePosition(clicked).writeVarInt(face)
      .writeFloat(0.5).writeFloat(0.5).writeFloat(0.5)
      .writeBoolean(false).writeBoolean(false).writeVarInt(++sequence);
    handlePlay(connection as never, PlayIn.UseItemOn, readerFor(packet));
  }
  function breakBlock(pos: Pos): void {
    const packet = new PacketWriter(PlayIn.PlayerAction).writeVarInt(0).writePosition(pos).writeByte(1).writeVarInt(++sequence);
    handlePlay(connection as never, PlayIn.PlayerAction, readerFor(packet));
  }
  const clientWasToldAir = (pos: Pos): boolean => sent
    .filter((p) => p.packetId === PlayOut.BlockUpdate)
    .some((p) => {
      const reader = new PacketReader(p.body());
      reader.readVarInt();
      const at = reader.readPosition();
      return at.x === pos.x && at.y === pos.y && at.z === pos.z && reader.readVarInt() === Block.Air;
    });

  /** Flat stone ground with 5 blocks of air above, around (x, z). Returns the top ground block. */
  function arena(x: number, z: number): Pos {
    const surface = world.getSpawnHeight(x, z) - 1;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      set({ x: x + dx, y: surface, z: z + dz }, Block.Stone);
      for (let dy = 1; dy <= 5; dy++) set({ x: x + dx, y: surface + dy, z: z + dz }, Block.Air);
    }
    return { x, y: surface, z };
  }

  // ---------------------------------------------------------------- a flower
  let ground = arena(200, 200);
  set(ground, defaultState("grass_block"));
  set(above(ground), defaultState("dandelion"));
  set({ x: 201, y: ground.y, z: 200 }, defaultState("grass_block"));
  set({ x: 201, y: ground.y + 1, z: 200 }, defaultState("poppy"));
  sent.length = 0;
  breakBlock(ground);
  assert.strictEqual(name(above(ground)), "air", "the flower breaks when the grass under it is gone");
  assert.ok(clientWasToldAir(above(ground)), "and the player is told");
  assert.strictEqual(name({ x: 201, y: ground.y + 1, z: 200 }), "poppy", "a flower somewhere else is left alone");
  console.log("ok a flower breaks when its ground is broken");

  // ---------------------------------------------------------------- tall plants
  ground = arena(210, 210);
  set(ground, defaultState("grass_block"));
  rightClick(ground, 1, "sunflower");
  assert.strictEqual(name(above(ground)), "sunflower");
  assert.strictEqual(describeState(world.getState(above(ground, 2))).properties.half, "upper", "placing a sunflower puts in both halves");
  breakBlock(above(ground, 2));
  assert.strictEqual(name(above(ground)), "air", "breaking the top half breaks the bottom half too");
  rightClick(ground, 1, "sunflower");
  breakBlock(ground);
  assert.strictEqual(name(above(ground)) + name(above(ground, 2)), "airair", "breaking the ground takes both halves");
  console.log("ok tall plants are placed and broken as a pair");

  // ---------------------------------------------------------------- sugar cane stack
  ground = arena(220, 220);
  set(ground, defaultState("sand"));
  for (let i = 1; i <= 3; i++) set(above(ground, i), defaultState("sugar_cane"));
  breakBlock(ground);
  assert.strictEqual([1, 2, 3].map((i) => name(above(ground, i))).join(), "air,air,air", "the whole stalk falls when its base goes");
  console.log("ok a sugar cane stalk breaks all the way up");

  // ---------------------------------------------------------------- placing where it cannot stay
  ground = arena(230, 230);
  rightClick(ground, 1, "dandelion");
  assert.strictEqual(name(above(ground)), "air", "a flower cannot be planted on stone");
  set(ground, defaultState("dirt"));
  rightClick(ground, 1, "dandelion");
  assert.strictEqual(name(above(ground)), "dandelion", "but it can on dirt");
  console.log("ok plants are refused where they could not stay");

  // ---------------------------------------------------------------- torches and ladders
  ground = arena(240, 240);
  rightClick(ground, 1, "torch");
  assert.strictEqual(name(above(ground)), "torch");
  breakBlock(ground);
  assert.strictEqual(name(above(ground)), "air", "a standing torch breaks with its block");

  ground = arena(250, 250);
  const wall = above(ground);
  set(wall, Block.Stone);
  const beside = { x: wall.x + 1, y: wall.y, z: wall.z };
  for (const torch of ["torch", "soul_torch", "redstone_torch"]) {
    rightClick(wall, 5, torch); // the east face of the wall block
    const placed = describeState(world.getState(beside));
    assert.ok(placed.name.endsWith("wall_torch"), `${torch} on a wall becomes a wall torch (got ${placed.name})`);
    assert.strictEqual(placed.properties.facing, "east");
    set(beside, Block.Air);
  }
  rightClick(wall, 5, "torch");
  breakBlock(wall);
  assert.strictEqual(name(beside), "air", "a wall torch breaks when the block behind it does");

  const ladderWall = { x: 250, y: ground.y + 2, z: 252 };
  const ladder = { x: 250, y: ground.y + 2, z: 253 };
  set(ladderWall, Block.Stone);
  set(ladder, stateOf("ladder", { facing: "south" }));
  breakBlock(ladderWall);
  assert.strictEqual(name(ladder), "air", "a ladder breaks when its wall does");
  console.log("ok torches and ladders break with their support");

  // ---------------------------------------------------------------- other blocks stay
  ground = arena(260, 260);
  set(above(ground), Block.Stone);
  set(above(ground, 2), Block.Stone);
  breakBlock(ground);
  assert.strictEqual(name(above(ground)) + name(above(ground, 2)), "stonestone", "ordinary blocks do not fall or break");
  console.log("ok blocks that need nothing stay put");

  console.log("ALL SUPPORT CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("SUPPORT CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
