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
  const { PacketReader } = await import("../src/network/PacketReader");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { Block } = await import("../src/world/blocks");

  type Pos = { x: number; y: number; z: number };
  const OAK_DOOR_ITEM = 324;
  const IRON_DOOR_ITEM = 330;
  const OAK_DOOR = 64;
  const IRON_DOOR = 71;

  // A stand-in for a client connection that records everything the server sends it.
  const sent: InstanceType<typeof PacketWriter>[] = [];
  const connection = {
    player: null as unknown,
    address: "test",
    send: (packet: InstanceType<typeof PacketWriter>) => sent.push(packet),
    disconnect: () => {},
  };

  const server = new MinecraftServer();
  server.addPlayer(connection as never, "Alice", "00000000-0000-0000-0000-000000000001");
  const player = (connection.player as { yaw: number; gameMode: number; isOp: boolean })!;
  player.gameMode = GameMode.Creative;

  const world = server.world;
  /** The packet body a client would send, without the length and id (which handlePlay is given separately). */
  const body = (id: number, fill: (w: InstanceType<typeof PacketWriter>) => void): InstanceType<typeof PacketReader> => {
    const writer = new PacketWriter(id);
    fill(writer);
    const bytes = writer.toBuffer();
    return new PacketReader(bytes.subarray(2)); // 1-byte length + 1-byte id
  };

  function rightClick(clicked: Pos, face: number, itemId: number): void {
    const reader = body(PlayIn.BlockPlacement, (w) =>
      w
        .writePosition(clicked)
        .writeByte(face)
        .writeShort(itemId)
        .writeByte(1)
        .writeShort(0)
        .writeByte(0) // no item data
        .writeByte(8)
        .writeByte(8)
        .writeByte(8), // where on the block's face the click was
    );
    handlePlay(connection as never, PlayIn.BlockPlacement, reader);
  }

  function breakBlock(pos: Pos): void {
    const reader = body(PlayIn.PlayerDigging, (w) => w.writeByte(0).writePosition(pos).writeByte(1));
    handlePlay(connection as never, PlayIn.PlayerDigging, reader);
  }

  /** Block changes the client was told about since `sent` was last cleared. */
  function blockChangesSent(): Array<{ pos: Pos; id: number; meta: number }> {
    return sent
      .filter((p) => p.packetId === PlayOut.BlockChange)
      .map((p) => {
        const bytes = p.toBuffer().subarray(2);
        const packed = bytes.readBigUInt64BE(0);
        let value = 0; // the block state is a VarInt: (block id << 4) | metadata
        let shift = 0;
        for (let i = 8; ; i++) {
          value |= (bytes[i] & 0x7f) << shift;
          shift += 7;
          if (!(bytes[i] & 0x80)) break;
        }
        return {
          pos: {
            x: Number(BigInt.asIntN(26, packed >> 38n)),
            y: Number(BigInt.asIntN(12, packed >> 26n)),
            z: Number(BigInt.asIntN(26, packed)),
          },
          id: value >> 4,
          meta: value & 15,
        };
      });
  }

  /** Flat free ground for a test: clears a 5x5x4 area above the surface and returns the block to click. */
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
  assert.strictEqual(world.getBlockId(above(base)), OAK_DOOR, "lower half missing");
  assert.strictEqual(world.getBlockId(above(base, 2)), OAK_DOOR, "upper half missing");
  assert.strictEqual(world.getBlockMetadata(above(base)), 1, "lower half faces south: metadata 1");
  assert.strictEqual(world.getBlockMetadata(above(base, 2)), 8, "upper half: bit 8, hinge left");
  const told = blockChangesSent().filter((c) => c.id === OAK_DOOR);
  assert.strictEqual(told.length, 2, "the client must be told about both halves");
  console.log("ok an oak door item places a two-block-tall door and the client is told");

  // Facing follows where the player looks.
  const facings: Array<[number, number]> = [[0, 1], [90, 2], [180, 3], [270, 0], [-90, 0], [45, 2]];
  for (const [yaw, expectedLowerMeta] of facings) {
    base = arena(120, 100);
    player.yaw = yaw;
    rightClick(base, 1, OAK_DOOR_ITEM);
    assert.strictEqual(world.getBlockMetadata(above(base)), expectedLowerMeta, `yaw ${yaw}`);
  }
  console.log("ok the door faces the way the player looks (all four directions)");

  // ---------------------------------------------------------------- open and close
  base = arena(140, 100);
  player.yaw = 0;
  rightClick(base, 1, OAK_DOOR_ITEM);
  sent.length = 0;
  rightClick(above(base, 2), 2, 0); // click the UPPER half with an empty hand
  assert.strictEqual(world.getBlockMetadata(above(base)), 1 | 4, "clicking the upper half opens the door (bit 4 on the lower half)");
  assert.ok(blockChangesSent().some((c) => c.pos.y === base.y + 1 && c.meta === 5), "the client must be told the door opened");
  rightClick(above(base), 2, 0); // click the lower half
  assert.strictEqual(world.getBlockMetadata(above(base)), 1, "clicking again closes it");
  rightClick(above(base), 2, OAK_DOOR_ITEM); // clicking with a door in hand still opens it instead of placing another
  assert.strictEqual(world.getBlockMetadata(above(base)), 5);
  assert.strictEqual(world.getBlockId(above(base, 3)), Block.Air, "no second door must be placed");
  console.log("ok right-clicking either half opens and closes the door");

  // Adventure mode can use doors but not place blocks; spectators can do neither.
  player.gameMode = GameMode.Adventure;
  rightClick(above(base), 2, 0);
  assert.strictEqual(world.getBlockMetadata(above(base)), 1, "adventure players can open doors");
  const other = arena(160, 100);
  rightClick(other, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId(above(other)), Block.Air, "adventure players cannot place doors");
  player.gameMode = GameMode.Spectator;
  rightClick(above(base), 2, 0);
  assert.strictEqual(world.getBlockMetadata(above(base)), 1, "spectators cannot open doors");
  player.gameMode = GameMode.Creative;
  console.log("ok game modes: adventure opens doors, spectator does nothing");

  // ---------------------------------------------------------------- iron doors
  base = arena(180, 100);
  rightClick(base, 1, IRON_DOOR_ITEM);
  assert.strictEqual(world.getBlockId(above(base)), IRON_DOOR);
  rightClick(above(base), 2, 0);
  assert.strictEqual(world.getBlockMetadata(above(base)), 1, "iron doors do not open by hand");
  console.log("ok iron doors place but do not open by hand");

  // ---------------------------------------------------------------- breaking
  for (const half of [1, 2]) {
    base = arena(200, 100);
    rightClick(base, 1, OAK_DOOR_ITEM);
    sent.length = 0;
    breakBlock(above(base, half));
    assert.strictEqual(world.getBlockId(above(base)), Block.Air, `breaking half ${half}: lower must go`);
    assert.strictEqual(world.getBlockId(above(base, 2)), Block.Air, `breaking half ${half}: upper must go`);
    assert.strictEqual(blockChangesSent().filter((c) => c.id === Block.Air).length, 2, "the client must be told both halves vanished");
  }
  console.log("ok breaking either half removes the whole door");

  // Breaking a block next to a door must not remove it.
  base = arena(220, 100);
  rightClick(base, 1, OAK_DOOR_ITEM);
  world.setBlock({ x: base.x + 1, y: base.y + 1, z: base.z }, Block.Stone);
  breakBlock({ x: base.x + 1, y: base.y + 1, z: base.z });
  assert.strictEqual(world.getBlockId(above(base)), OAK_DOOR, "a neighbouring block was broken but the door vanished");
  console.log("ok breaking a neighbouring block leaves the door alone");

  // ---------------------------------------------------------------- refusals
  base = arena(240, 100);
  sent.length = 0;
  rightClick(base, 2, OAK_DOOR_ITEM); // side face, not the top
  assert.strictEqual(world.getBlockId({ x: base.x, y: base.y, z: base.z - 1 }), Block.Stone);
  assert.strictEqual(world.getBlockId({ x: base.x, y: base.y + 1, z: base.z - 1 }), Block.Air, "doors only go on top of a block");
  assert.ok(blockChangesSent().length > 0, "a refused door must be undone on the client");

  world.setBlock(above(base, 2), Block.Stone); // no room for the upper half
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId(above(base)), Block.Air, "a door needs two free blocks");
  world.setBlock(above(base, 2), Block.Air);

  const floating = { x: base.x + 2, y: base.y + 3, z: base.z };
  rightClick(floating, 1, OAK_DOOR_ITEM); // click on air high above the ground: nothing to stand on
  assert.strictEqual(world.getBlockId(above(floating)), Block.Air);
  console.log("ok doors are refused on side faces, without room, or without support (and the client is corrected)");

  // Plugins can cancel a door placement just like any block.
  const cancelPlugin = server.plugins;
  cancelPlugin.enable({
    name: "no-doors",
    version: "1",
    onEnable(api) {
      api.on("blockPlace", (event) => {
        if (event.blockId === OAK_DOOR) event.cancelled = true;
      });
    },
  });
  sent.length = 0;
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId(above(base)), Block.Air, "a cancelled door must not appear");
  assert.ok(blockChangesSent().length > 0, "the client must be corrected after a cancelled door");
  cancelPlugin.disable("no-doors");
  console.log("ok plugins can cancel door placement");

  // ---------------------------------------------------------------- hinge
  base = arena(260, 100);
  player.yaw = 0; // facing south: the right-hand side (clockwise) is west (-x)
  world.setBlock({ x: base.x - 1, y: base.y + 1, z: base.z }, Block.Stone);
  world.setBlock({ x: base.x - 1, y: base.y + 2, z: base.z }, Block.Stone);
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockMetadata(above(base, 2)), 8 | 1, "with a wall on the right, the hinge goes on the right");

  base = arena(280, 100);
  rightClick(base, 1, OAK_DOOR_ITEM);
  const second = { x: base.x + 1, y: base.y, z: base.z }; // next door along, on the left-hand side (east)
  rightClick(second, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId(above(second)), OAK_DOOR);
  assert.strictEqual(world.getBlockMetadata(above(second, 2)) & 1, 0, "next to another door on its right, the hinge stays left");
  console.log("ok hinge placement follows walls and neighbouring doors");

  // ---------------------------------------------------------------- shapes (vanilla cares about the block shape, not just light)
  const STAIRS = 53;
  const STONE_SLAB = 44;
  const HOPPER = 154;
  const doorAt = (b: Pos): boolean => world.getBlockId(above(b)) === OAK_DOOR;

  // Stairs stop light but are not full cubes, so they must not pull the hinge towards them.
  base = arena(300, 100);
  player.yaw = 0; // facing south: the right-hand side is west (-x)
  world.setBlock({ x: base.x - 1, y: base.y + 1, z: base.z }, STAIRS);
  world.setBlock({ x: base.x - 1, y: base.y + 2, z: base.z }, STAIRS);
  rightClick(base, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockMetadata(above(base, 2)), 8, "stairs beside a door must not move the hinge (still on the left)");
  console.log("ok stairs beside a door do not count as a wall for the hinge");

  // What may hold a door up.
  const supports: Array<[string, number, number, boolean]> = [
    ["a full block", Block.Stone, 0, true],
    ["a bottom slab", STONE_SLAB, 0, false],
    ["a top slab", STONE_SLAB, 8, true],
    ["a normal stair", STAIRS, 0, false],
    ["an upside-down stair", STAIRS, 4, true],
    ["a hopper", HOPPER, 0, true],
    ["a full-height snow layer", 78, 7, true],
    ["a thin snow layer", 78, 0, false],
    ["farmland", 60, 0, false],
  ];
  for (const [name, id, meta, allowed] of supports) {
    base = arena(320, 100);
    world.setBlock(base, id, meta);
    rightClick(base, 1, OAK_DOOR_ITEM);
    assert.strictEqual(doorAt(base), allowed, "a door " + (allowed ? "should" : "should not") + " go on " + name);
  }
  console.log("ok doors need a solid top surface: full blocks, top slabs, upside-down stairs and hoppers work; bottom slabs and stairs do not");

  // Top of the world: the lower half may be at y=254 (the upper half is then at 255), but not at 255.
  const column = { x: 340, y: 253, z: 100 };
  world.setBlock(column, Block.Stone);
  for (const y of [254, 255]) world.setBlock({ x: column.x, y, z: column.z }, Block.Air);
  rightClick(column, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId({ x: column.x, y: 254, z: column.z }), OAK_DOOR, "lower half at y=254 is allowed");
  assert.strictEqual(world.getBlockId({ x: column.x, y: 255, z: column.z }), OAK_DOOR, "upper half at y=255");
  const roof = { x: 342, y: 254, z: 100 };
  world.setBlock(roof, Block.Stone);
  world.setBlock({ x: roof.x, y: 255, z: roof.z }, Block.Air);
  rightClick(roof, 1, OAK_DOOR_ITEM);
  assert.strictEqual(world.getBlockId({ x: roof.x, y: 255, z: roof.z }), Block.Air, "no door when the lower half would be at y=255");
  console.log("ok doors fit up to the top of the world, but no higher");

  console.log("ALL DOOR CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("DOOR CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`(could not delete the temporary folder ${workDir}; it is safe to delete by hand)`);
    }
  });
