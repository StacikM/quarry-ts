/**
 * Checks loading an existing Minecraft world (Anvil region files) as the server's map.
 * The test world is built here with prismarine-nbt, a separate NBT writer, and packed
 * with a separate piece of code, so a mistake in our reader cannot hide itself.
 * Run with:  npx tsx scripts/anvil-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-anvil-"));
process.chdir(workDir);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nbt = require("prismarine-nbt");

type Palette = Array<{ name: string; props?: Record<string, string> }>;

/** A section's block_states tag: the palette, and the packed indices when there is more than one entry. */
function blockStates(palette: Palette, indices?: (i: number) => number): any {
  const entries = palette.map((entry) =>
    nbt.comp({ Name: nbt.string(entry.name), ...(entry.props ? { Properties: nbt.comp(Object.fromEntries(Object.entries(entry.props).map(([k, v]) => [k, nbt.string(v)]))) } : {}) }),
  );
  if (palette.length === 1 || !indices) return nbt.comp({ palette: nbt.list(nbt.comp(entries.map((e: any) => e.value))) });

  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const perLong = Math.floor(64 / bits);
  const longs: Array<[number, number]> = [];
  for (let first = 0; first < 4096; first += perLong) {
    let value = 0n;
    for (let k = 0; k < perLong && first + k < 4096; k++) value |= BigInt(indices(first + k)) << BigInt(k * bits);
    const signed = BigInt.asIntN(64, value);
    longs.push([Number(signed >> 32n), Number(signed & 0xffffffffn) | 0]);
  }
  return nbt.comp({ palette: nbt.list(nbt.comp(entries.map((e: any) => e.value))), data: nbt.longArray(longs) });
}

function section(y: number, states: any, biomes?: string): any {
  return {
    Y: nbt.byte(y),
    block_states: states,
    biomes: nbt.comp({ palette: nbt.list(nbt.string([biomes ?? "minecraft:plains"])) }),
  };
}

function chunkNbt(x: number, z: number, sections: any[], dataVersion = 4671): Buffer {
  const tag = nbt.comp({
    DataVersion: nbt.int(dataVersion),
    xPos: nbt.int(x),
    zPos: nbt.int(z),
    sections: nbt.list(nbt.comp(sections)),
  }, "");
  return nbt.writeUncompressed(tag, "big");
}

/** Builds a region file from chunks keyed by their slot, with the given compression type for each. */
function regionFile(chunks: Array<{ slot: number; data: Buffer; compression?: number; raw?: boolean }>): Buffer {
  const header = Buffer.alloc(8192);
  const parts: Buffer[] = [header];
  let sector = 2;
  for (const { slot, data, compression = 2, raw } of chunks) {
    const payload = raw ? data : compression === 1 ? zlib.gzipSync(data) : compression === 2 ? zlib.deflateSync(data) : data;
    const entry = Buffer.alloc(Math.ceil((payload.length + 5) / 4096) * 4096);
    entry.writeUInt32BE(payload.length + 1, 0);
    entry[4] = compression;
    payload.copy(entry, 5);
    header.writeUInt32BE((sector << 8) | (entry.length / 4096), slot * 4);
    parts.push(entry);
    sector += entry.length / 4096;
  }
  return Buffer.concat(parts);
}

async function main(): Promise<void> {
  const { AnvilGenerator, readMapSpawn } = await import("../src/world/anvil/AnvilGenerator");
  const { readNbt } = await import("../src/world/anvil/nbtReader");
  const { World } = await import("../src/world/World");
  const { stateOf } = await import("../src/world/blockStates");
  const { biomeId } = await import("../src/world/biomeIds");
  const { Block } = await import("../src/world/blocks");

  const map = path.join(workDir, "My Lobby Map");
  fs.mkdirSync(path.join(map, "region"), { recursive: true });
  const at = (x: number, y: number, z: number) => ({ x, y, z });

  // ------------------------------------------------------------ the test map
  // Chunk 0,0: section 0 has 3 kinds of block (4 bits each), section 1 has 20 kinds (5 bits each, which straddle the longs),
  // section 2 is all stone, and sections -1 and 16 are outside the part we load.
  const small: Palette = [{ name: "minecraft:air" }, { name: "minecraft:stone" }, { name: "minecraft:oak_stairs", props: { facing: "east", half: "top", shape: "straight", waterlogged: "false" } }];
  const smallIndex = (i: number): number => (i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0);
  const many: Palette = [{ name: "minecraft:air" }];
  const woods = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "bamboo", "crimson", "warped", "pale_oak"];
  for (const wood of woods) many.push({ name: `minecraft:${wood}_planks` });
  many.push({ name: "minecraft:stone" }, { name: "minecraft:dirt" }, { name: "minecraft:sand" }, { name: "minecraft:gravel" }, { name: "minecraft:clay" }, { name: "minecraft:gold_block" }, { name: "minecraft:made_up_mod:thing" });
  assert.ok(many.length > 16 && many.length <= 32);
  const manyIndex = (i: number): number => (i * 5 + (i >> 8)) % many.length;

  const chunk00 = chunkNbt(0, 0, [
    section(0, blockStates(small, smallIndex), "minecraft:desert"),
    section(1, blockStates(many, manyIndex)),
    section(2, blockStates([{ name: "minecraft:stone" }])),
    section(4, blockStates([{ name: "minecraft:air" }]), "minecraft:desert"),
    section(-1, blockStates([{ name: "minecraft:stone" }])),
    section(16, blockStates([{ name: "minecraft:gold_block" }])),
  ]);
  const chunkMinus = chunkNbt(-1, -1, [section(3, blockStates([{ name: "minecraft:glass" }]))]);
  const chunkOld = chunkNbt(2, 0, [section(0, blockStates([{ name: "minecraft:stone" }]))], 2000);
  const chunkNoCompression = chunkNbt(3, 0, [section(0, blockStates([{ name: "minecraft:dirt" }]))]);
  const chunkGzip = chunkNbt(4, 0, [section(0, blockStates([{ name: "minecraft:sand" }]))]);

  fs.writeFileSync(
    path.join(map, "region", "r.0.0.mca"),
    regionFile([
      { slot: 0, data: chunk00 },
      { slot: 2, data: chunkOld },
      { slot: 3, data: chunkNoCompression, compression: 3 },
      { slot: 4, data: chunkGzip, compression: 1 },
      { slot: 5, data: Buffer.from("this is not compressed data at all"), raw: true }, // damaged
      { slot: 6, data: chunk00, compression: 4 }, // lz4: not supported
    ]),
  );
  fs.writeFileSync(path.join(map, "region", "r.-1.-1.mca"), regionFile([{ slot: 31 + 31 * 32, data: chunkMinus }]));

  const generator = new AnvilGenerator(map);
  const world = new World(generator);
  const quietly = <T>(fn: () => T): T => {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      return fn();
    } finally {
      Object.assign(console, saved);
    }
  };

  // ------------------------------------------------------------ the blocks
  {
    const stairs = stateOf("oak_stairs", { facing: "east", half: "top", shape: "straight", waterlogged: false });
    let checked = 0;
    for (let i = 0; i < 4096; i += 1) {
      const pos = at(i & 15, i >> 8, (i >> 4) & 15);
      const expected = [Block.Air, Block.Stone, stairs][smallIndex(i)];
      assert.strictEqual(world.getState(pos), expected, `section 0, block ${i}`);
      checked++;
    }
    const manyStates = many.map((entry) => {
      try {
        return stateOf(entry.name);
      } catch {
        return Block.Air; // the made-up block
      }
    });
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(world.getState(at(i & 15, 16 + (i >> 8), (i >> 4) & 15)), manyStates[manyIndex(i)], `section 1, block ${i}`);
      checked++;
    }
    assert.strictEqual(world.getState(at(7, 40, 7)), Block.Stone, "a section with one kind of block");
    assert.strictEqual(world.getState(at(5, 255, 5)), Block.Air, "empty sections are air");
    assert.strictEqual(world.getState(at(0, 300, 0)), Block.Air);
    console.log(`ok blocks: ${checked} blocks read from palettes of 3 and 20 entries, exactly as packed`);
  }

  // ------------------------------------------------------------ range, biomes, other chunks
  {
    assert.strictEqual(generator.outOfRangeChunks, 1, "blocks above y=255 and below y=0 are noticed (and dropped)");
    assert.strictEqual(world.getChunk(0, 0).getBiome(3, 3), biomeId("desert"), "biomes come from the section around y=64");
    assert.strictEqual(world.getChunk(-1, -1).getBiome(0, 0), biomeId("plains"));
    assert.strictEqual(world.getState(at(-1, 48, -1)), stateOf("glass"), "negative chunk and region coordinates");
    assert.strictEqual(world.getState(at(-16, 48, -16)), stateOf("glass"));
    assert.strictEqual(world.getState(at(-17, 48, -16)), Block.Air, "the chunk next to it is not in the map");
    assert.strictEqual(world.getState(at(3 * 16 + 1, 2, 1)), stateOf("dirt"), "uncompressed chunk data");
    assert.strictEqual(world.getState(at(4 * 16 + 1, 2, 1)), stateOf("sand"), "gzip chunk data");
    assert.strictEqual(world.getState(at(1000, 60, 1000)), Block.Air, "a chunk in a region the map does not have");
    console.log("ok out-of-range blocks, biomes, negative coordinates, gzip and uncompressed chunks");
  }

  // ------------------------------------------------------------ trouble
  {
    assert.strictEqual(quietly(() => world.getState(at(2 * 16 + 1, 2, 1))), Block.Air, "a chunk from a world older than 1.18 is empty, not a crash");
    assert.strictEqual(quietly(() => world.getState(at(5 * 16 + 1, 2, 1))), Block.Air, "a damaged chunk is empty, not a crash");
    assert.strictEqual(quietly(() => world.getState(at(6 * 16 + 1, 2, 1))), Block.Air, "an unsupported compression type is empty, not a crash");
    assert.throws(() => new AnvilGenerator(path.join(workDir, "nowhere")), /region/);
    console.log("ok old, damaged and unsupported chunks become empty chunks with a warning");
  }

  // ------------------------------------------------------------ edits on top, the map is not changed
  {
    const before = fs.readFileSync(path.join(map, "region", "r.0.0.mca"));
    const { WorldStorage } = await import("../src/world/WorldStorage");
    const saves = path.join(workDir, "saves");
    const editable = new World(new AnvilGenerator(map), new WorldStorage(saves));
    editable.setBlock(at(7, 40, 7), Block.Air);
    editable.setBlock(at(100, 70, 100), Block.Stone);
    assert.deepStrictEqual(editable.saveDirtyChunks(), { saved: 2, failed: 0 });
    const reopened = new World(new AnvilGenerator(map), new WorldStorage(saves));
    assert.strictEqual(reopened.getState(at(7, 40, 7)), Block.Air, "an edit on top of the map survives a restart");
    assert.strictEqual(reopened.getState(at(8, 40, 7)), Block.Stone, "and the rest of the map is still there");
    assert.strictEqual(reopened.getState(at(100, 70, 100)), Block.Stone);
    assert.ok(before.equals(fs.readFileSync(path.join(map, "region", "r.0.0.mca"))), "the map files are never changed");
    assert.ok(generator.name.startsWith("map-My_Lobby_Map"), "each map has its own save folder name");
    console.log("ok player edits are saved next to the map and layered on top; the map folder is untouched");
  }

  // ------------------------------------------------------------ level.dat
  {
    const levelDat = (data: any): void => fs.writeFileSync(path.join(map, "level.dat"), zlib.gzipSync(nbt.writeUncompressed(nbt.comp({ Data: nbt.comp(data) }, ""), "big")));
    assert.strictEqual(readMapSpawn(map), null, "no level.dat: no spawn");
    levelDat({ SpawnX: nbt.int(10), SpawnY: nbt.int(80), SpawnZ: nbt.int(-5) });
    assert.deepStrictEqual(readMapSpawn(map), { x: 10, y: 80, z: -5 });
    levelDat({ spawn: nbt.comp({ pos: nbt.intArray([1, 2, 3]) }) });
    assert.deepStrictEqual(readMapSpawn(map), { x: 1, y: 2, z: 3 }, "the newer way of saving the spawn");
    fs.writeFileSync(path.join(map, "level.dat"), "garbage");
    assert.strictEqual(readMapSpawn(map), null, "a damaged level.dat is ignored");
    console.log("ok the map's spawn point is read from level.dat (old and new layout)");
  }

  // ------------------------------------------------------------ the NBT reader on its own
  {
    const tag = nbt.comp({
      byte: nbt.byte(-3), short: nbt.short(-300), int: nbt.int(-70000), long: nbt.long([0x7fffffff, 0xffffffff | 0]), float: nbt.float(1.5), double: nbt.double(-2.25),
      text: nbt.string("héllo \u0000 世界"), bytes: nbt.byteArray([1, -2, 3]), ints: nbt.intArray([5, -6]), longs: nbt.longArray([[0, 7], [-1, -1]]),
      list: nbt.list(nbt.int([1, 2, 3])), inner: nbt.comp({ deep: nbt.string("x") }),
    }, "");
    const read: any = readNbt(nbt.writeUncompressed(tag, "big"));
    assert.deepStrictEqual([read.byte, read.short, read.int, read.long, read.float, read.double], [-3, -300, -70000, 0x7fffffffffffffffn, 1.5, -2.25]);
    assert.strictEqual(read.text, "héllo \u0000 世界");
    assert.deepStrictEqual([read.bytes, read.ints, read.list], [[1, -2, 3], [5, -6], [1, 2, 3]]);
    assert.deepStrictEqual(Array.from(read.longs), [7n, -1n]);
    assert.strictEqual(read.inner.deep, "x");
    const bytes = nbt.writeUncompressed(tag, "big");
    for (const cut of [1, 5, bytes.length - 1]) assert.throws(() => readNbt(bytes.subarray(0, cut)), /NBT/);
    assert.throws(() => readNbt(Buffer.from([1, 0, 0, 5])), /compound/);
    // deeply nested lists must not overflow the stack
    const nested = Buffer.concat([Buffer.from([10, 0, 0, 9, 0, 1, 9, 0, 0, 0, 1]), Buffer.concat(Array.from({ length: 200 }, () => Buffer.from([9, 0, 0, 0, 1])))]);
    assert.throws(() => readNbt(nested));
    console.log("ok NBT reader: every tag type, modified UTF-8, truncated and nested input");
  }

  console.log("ALL ANVIL CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("ANVIL CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
