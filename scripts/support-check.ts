/**
 * Checks that plants, torches, ladders and doors break when what they stand on goes away, and cannot be
 * placed where they could not stay.
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
  const { PacketReader } = await import("../src/network/PacketReader");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { Block } = await import("../src/world/blocks");

  type Pos = { x: number; y: number; z: number };
  const TORCH = 50;
  const LADDER = 65;
  const CARPET = 171;
  const DOUBLE_PLANT = 175;
  const OAK_DOOR_ITEM = 324;
  const OAK_DOOR = 64;

  const sent: InstanceType<typeof PacketWriter>[] = [];
  const connection = {
    player: null as unknown,
    address: "test",
    send: (packet: InstanceType<typeof PacketWriter>) => sent.push(packet),
    disconnect: () => {},
  };
  const server = new MinecraftServer();
  server.addPlayer(connection as never, "Alice", "00000000-0000-0000-0000-000000000001");
  const player = connection.player as { yaw: number; gameMode: number };
  player.gameMode = GameMode.Creative;

  const world = server.world;
  const body = (id: number, fill: (w: InstanceType<typeof PacketWriter>) => void): InstanceType<typeof PacketReader> => {
    const writer = new PacketWriter(id);
    fill(writer);
    return new PacketReader(writer.toBuffer().subarray(2)); // 1-byte length + 1-byte id
  };
  /** Right-click `clicked` on `face` (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east) holding an item. */
  function rightClick(clicked: Pos, face: number, itemId: number, damage = 0): void {
    const reader = body(PlayIn.BlockPlacement, (w) =>
      w.writePosition(clicked).writeByte(face).writeShort(itemId).writeByte(1).writeShort(damage).writeByte(0).writeByte(8).writeByte(8).writeByte(8),
    );
    handlePlay(connection as never, PlayIn.BlockPlacement, reader);
  }
  function breakBlock(pos: Pos): void {
    handlePlay(connection as never, PlayIn.PlayerDigging, body(PlayIn.PlayerDigging, (w) => w.writeByte(0).writePosition(pos).writeByte(1)));
  }
  /** Whether the client was told that `pos` is air. */
  function clientWasToldAir(pos: Pos): boolean {
    return sent
      .filter((p) => p.packetId === PlayOut.BlockChange)
      .some((p) => {
        const bytes = p.toBuffer().subarray(2);
        const packed = bytes.readBigUInt64BE(0);
        let value = 0;
        let shift = 0;
        for (let i = 8; ; i++) {
          value |= (bytes[i] & 0x7f) << shift;
          shift += 7;
          if (!(bytes[i] & 0x80)) break;
        }
        const at = { x: Number(BigInt.asIntN(26, packed >> 38n)), y: Number(BigInt.asIntN(12, packed >> 26n)), z: Number(BigInt.asIntN(26, packed)) };
        return at.x === pos.x && at.y === pos.y && at.z === pos.z && value >> 4 === Block.Air;
      });
  }
  const id = (pos: Pos): number => world.getBlockId(pos);
  const above = (p: Pos, n = 1): Pos => ({ x: p.x, y: p.y + n, z: p.z });
  const set = (pos: Pos, blockId: number, meta = 0): void => world.setBlock(pos, blockId, meta);

  /** Flat stone ground with air above, around (x, z). Returns the top ground block. */
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
  set(ground, Block.Grass);
  set(above(ground), Block.Dandelion);
  set({ x: 201, y: ground.y, z: 200 }, Block.Grass);
  set({ x: 201, y: ground.y + 1, z: 200 }, Block.Poppy);
  sent.length = 0;
  breakBlock(ground);
  assert.strictEqual(id(above(ground)), Block.Air, "the flower breaks when the grass under it is gone");
  assert.ok(clientWasToldAir(above(ground)), "and the player is told");
  assert.strictEqual(id({ x: 201, y: ground.y + 1, z: 200 }), Block.Poppy, "a flower somewhere else is left alone");
  console.log("ok a flower breaks when its ground is broken");

  // ---------------------------------------------------------------- tall plants
  ground = arena(210, 210);
  set(ground, Block.Grass);
  rightClick(ground, 1, DOUBLE_PLANT, 0);
  assert.strictEqual(id(above(ground)), DOUBLE_PLANT);
  assert.strictEqual(id(above(ground, 2)), DOUBLE_PLANT, "placing a tall flower puts in both halves");
  assert.strictEqual(world.getBlockMetadata(above(ground, 2)), 8, "the top half is marked");
  breakBlock(above(ground, 2));
  assert.strictEqual(id(above(ground)), Block.Air, "breaking the top half breaks the bottom half too");
  rightClick(ground, 1, DOUBLE_PLANT, 0);
  breakBlock(ground);
  assert.strictEqual(id(above(ground)) + id(above(ground, 2)), 0, "breaking the ground takes both halves");
  console.log("ok tall plants are placed and broken as a pair");

  // ---------------------------------------------------------------- sugar cane stack
  ground = arena(220, 220);
  set(ground, Block.Sand);
  for (let i = 1; i <= 3; i++) set(above(ground, i), Block.SugarCane);
  breakBlock(ground);
  assert.deepStrictEqual([1, 2, 3].map((i) => id(above(ground, i))), [0, 0, 0], "the whole stalk falls when its base goes");
  console.log("ok a sugar cane stalk breaks all the way up");

  // ---------------------------------------------------------------- placing where it cannot stay
  ground = arena(230, 230);
  rightClick(ground, 1, Block.Dandelion);
  assert.strictEqual(id(above(ground)), Block.Air, "a flower cannot be planted on stone");
  set(ground, Block.Dirt);
  rightClick(ground, 1, Block.Dandelion);
  assert.strictEqual(id(above(ground)), Block.Dandelion, "but it can on dirt");
  ground = arena(235, 235);
  rightClick(ground, 1, Block.Cactus);
  assert.strictEqual(id(above(ground)), Block.Air, "a cactus needs sand");
  set(ground, Block.Sand);
  rightClick(ground, 1, Block.Cactus);
  assert.strictEqual(id(above(ground)), Block.Cactus, "and grows on sand");
  console.log("ok plants are refused where they could not stay");

  // ---------------------------------------------------------------- torches
  ground = arena(240, 240);
  rightClick(ground, 1, TORCH);
  assert.strictEqual(id(above(ground)), TORCH);
  assert.strictEqual(world.getBlockMetadata(above(ground)), 5, "a torch on the floor stands");
  breakBlock(ground);
  assert.strictEqual(id(above(ground)), Block.Air, "a standing torch breaks with its block");

  ground = arena(250, 250);
  const wall = above(ground);
  set(wall, Block.Stone);
  const east = { x: wall.x + 1, y: wall.y, z: wall.z };
  rightClick(wall, 5, TORCH); // the east face of the wall block
  assert.strictEqual(id(east), TORCH);
  assert.strictEqual(world.getBlockMetadata(east), 1, "a torch on an east face leans east");
  breakBlock(wall);
  assert.strictEqual(id(east), Block.Air, "a wall torch breaks when the block behind it does");
  const ceiling = above(ground, 3);
  set(ceiling, Block.Stone);
  rightClick(ceiling, 0, TORCH); // the underside of a block: a ceiling
  assert.strictEqual(id(above(ground, 2)), Block.Air, "a torch cannot be put on a ceiling");
  console.log("ok torches take the side they are put on, and break with their support");

  // ---------------------------------------------------------------- ladders
  ground = arena(260, 260);
  const ladderWall = above(ground);
  set(ladderWall, Block.Stone);
  const ladderSpot = { x: ladderWall.x, y: ladderWall.y, z: ladderWall.z + 1 };
  rightClick(ladderWall, 3, LADDER); // the south face
  assert.strictEqual(id(ladderSpot), LADDER);
  assert.strictEqual(world.getBlockMetadata(ladderSpot), 3, "a ladder on a south face faces south");
  rightClick(ground, 1, LADDER);
  assert.strictEqual(id(above(ground, 1)), Block.Stone, "a ladder cannot be put flat on the floor (the wall block is still there)");
  breakBlock(ladderWall);
  assert.strictEqual(id(ladderSpot), Block.Air, "a ladder breaks when its wall does");
  console.log("ok ladders hang on walls and break with them");

  // ---------------------------------------------------------------- doors and carpets
  ground = arena(270, 270);
  player.yaw = 0;
  rightClick(ground, 1, OAK_DOOR_ITEM);
  assert.strictEqual(id(above(ground)), OAK_DOOR);
  breakBlock(ground);
  assert.strictEqual(id(above(ground)) + id(above(ground, 2)), 0, "a door goes when its floor does (both halves)");
  ground = arena(275, 275);
  rightClick(ground, 1, CARPET, 3);
  assert.strictEqual(id(above(ground)), CARPET);
  assert.strictEqual(world.getBlockMetadata(above(ground)), 3, "the colour of the carpet is kept");
  breakBlock(ground);
  assert.strictEqual(id(above(ground)), Block.Air, "a carpet goes with its floor");
  console.log("ok doors and carpets need their floor");

  // ---------------------------------------------------------------- other blocks stay
  ground = arena(280, 280);
  set(above(ground), Block.Stone);
  set(above(ground, 2), Block.Stone);
  breakBlock(ground);
  assert.strictEqual(id(above(ground)) + id(above(ground, 2)), 2, "ordinary blocks do not fall or break");
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
