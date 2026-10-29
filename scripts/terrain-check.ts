/** Run: npx tsx scripts/terrain-check.ts */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Chunk } from "../src/world/Chunk";
import { Block } from "../src/world/blocks";
import { NaturalGenerator } from "../src/world/terrain/NaturalGenerator";
import { PerlinNoise } from "../src/world/terrain/noise";
import { RiverSampler } from "../src/world/terrain/rivers";

const generator = new NaturalGenerator(1337);
function generate(x: number, z: number): Chunk {
  const chunk = new Chunk(x, z);
  generator.generate(chunk);
  return chunk;
}
const coordinates = [[-17, 19], [0, 0], [12, -9], [-1, -1]];
const snapshots = coordinates.map(([x, z]) => generate(x, z).serialize().data);
for (let i = coordinates.length - 1; i >= 0; i--) {
  assert.deepEqual(generate(...coordinates[i] as [number, number]).serialize().data, snapshots[i]);
}
const different = new Chunk(-17, 19);
new NaturalGenerator(1338).generate(different);
assert.notDeepEqual(different.serialize().data, snapshots[0]);
// Known forest roots at x=-129 reach across the -9/-8 chunk boundary.
for (const z of [31, 58]) {
  const cz = Math.floor(z / 16), localZ = z - cz * 16;
  const rightFirst = generate(-8, cz);
  const leftSecond = generate(-9, cz);
  const ground = generator.heightAt(-129, z);
  assert.equal(leftSecond.getBlockId(15, ground + 1, localZ), Block.Log);
  let top = ground + 1;
  while (leftSecond.getBlockId(15, top + 1, localZ) === Block.Log) top++;
  assert.equal(rightFirst.getBlockId(1, top - 1, localZ), Block.Leaves, "neighbor-root canopy reaches this chunk");
  assert.deepEqual(generate(-8, cz).serialize().data, rightFirst.serialize().data);
}
for (let seed = -50; seed < 50; seed++) {
  const g = new NaturalGenerator(seed);
  for (let z = -8; z <= 8; z++) for (let x = -8; x <= 8; x++) assert.equal(g.heightAt(x, z), 72);
}
const counts = new Map<number, number>();
const treeSpecies = new Set<number>();
const biomeCounts = new Map<number, number>();
let riverBorderColumns = 0;
const borderChunks = new Map<string, Chunk>();
const oreLimits = new Map<number, number>([[16, 127], [15, 63], [14, 31], [73, 15], [56, 15], [21, 31]]);
for (let cz = -32; cz <= 32; cz += 4) for (let cx = -32; cx <= 32; cx += 4) {
  const chunk = generate(cx, cz);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const height = generator.heightAt(cx * 16 + x, cz * 16 + z);
    const biome = chunk.getBiome(x, z);
    biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
    if (biome === 7) {
      assert(height >= 57 && height < 62);
      assert([Block.Sand, Block.Gravel].includes(chunk.getBlockId(x, height, z) as 12 | 13));
      if (x === 0 || x === 15 || z === 0 || z === 15) riverBorderColumns++;
      // Water cannot contact a cave through an adjacent bank, even across chunk edges.
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const wx = cx * 16 + x + dx, wz = cz * 16 + z + dz;
        const bankHeight = generator.heightAt(wx, wz);
        if (bankHeight <= height) continue;
        const bx = Math.floor(wx / 16), bz = Math.floor(wz / 16), key = `${bx},${bz}`;
        let neighbor = bx === cx && bz === cz ? chunk : borderChunks.get(key);
        if (!neighbor) { neighbor = generate(bx, bz); borderChunks.set(key, neighbor); }
        for (let y = height + 1; y <= Math.min(62, bankHeight); y++) {
          const id = neighbor.getBlockId(((wx % 16) + 16) % 16, y, ((wz % 16) + 16) % 16);
          assert.notEqual(id, Block.Air, "river bank must separate water from cave air");
          assert.notEqual(id, Block.Lava);
        }
      }
    }
    assert.equal(chunk.getBlockId(x, 0, z), Block.Bedrock);
    for (let y = height - 4; y <= height; y++) {
      assert.notEqual(chunk.getBlockId(x, y, z), Block.Air, "sealed surface");
      assert.notEqual(chunk.getBlockId(x, y, z), Block.Lava);
    }
    for (let y = height + 1; y <= 62; y++) assert.equal(chunk.getBlockId(x, y, z), Block.Water);
    const decoration = chunk.getBlockId(x, height + 1, z);
    if ([Block.TallGrass, Block.Dandelion, Block.Poppy].includes(decoration as 31 | 37 | 38)) {
      assert.equal(chunk.getBlockId(x, height, z), Block.Grass);
    }
    if (decoration === Block.TallGrass) assert.equal(chunk.getBlockMetadata(x, height + 1, z), 1);
    if (decoration === Block.Cactus || decoration === Block.DeadBush) {
      assert.equal(chunk.getBlockId(x, height, z), Block.Sand);
      assert.equal(biome, 2);
    }
    if (decoration === Block.Cactus) {
      let tall = 1;
      while (chunk.getBlockId(x, height + tall + 1, z) === Block.Cactus) tall++;
      assert(tall >= 1 && tall <= 3);
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        assert(generator.heightAt(cx * 16 + x + dx, cz * 16 + z + dz) <= height);
      }
    }
    if (decoration === Block.SugarCane) {
      assert.equal(height, 62);
      assert([Block.Sand, Block.Grass].includes(chunk.getBlockId(x, height, z) as 2 | 12));
      assert([[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => generator.heightAt(cx * 16 + x + dx, cz * 16 + z + dz) < 62));
    }
    for (let y = 1; y <= Math.max(height + 12, 62); y++) {
      const id = chunk.getBlockId(x, y, z);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (id === Block.Log) treeSpecies.add(chunk.getBlockMetadata(x, y, z));
      if (oreLimits.has(id)) assert(y >= 5 && y <= oreLimits.get(id)!);
      if (id === Block.Lava) assert(y >= 5 && y < 10);
      if (id === Block.Air && y < height - 4) assert(y >= 10, "deep caves contain lava");
    }
  }
}
for (const id of [Block.Log, Block.Leaves, Block.Lava, Block.Snow, ...oreLimits.keys()]) assert((counts.get(id) ?? 0) > 0, `missing block ${id}`);
for (const id of [0, 1, 2, 3, 4, 7, 12, 16]) assert((biomeCounts.get(id) ?? 0) > 0, `missing biome ${id}`);
assert(riverBorderColumns > 0, "river channels cross chunk borders");
for (const id of [Block.TallGrass, Block.Dandelion, Block.Poppy, Block.DeadBush, Block.Cactus, Block.SugarCane]) assert((counts.get(id) ?? 0) > 0, `missing decoration ${id}`);
assert.deepEqual([...treeSpecies].sort(), [0, 1, 2], "oak, spruce and birch metadata");
for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
  const chunk = generate(Math.floor(x / 16), Math.floor(z / 16));
  const localX = (x + 16) % 16, localZ = (z + 16) % 16;
  assert.equal(chunk.getBlockId(localX, 73, localZ), Block.Air, "3x3 spawn clearance");
}
const area: [number, number][] = [];
for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) area.push([x, z]);
const forward = area.map(([x, z]) => generate(x, z).serialize().data);
for (let i = area.length - 1; i >= 0; i--) assert.deepEqual(generate(...area[i]).serialize().data, forward[i]);
const riverArea = area.map(([x, z]): [number, number] => [x + 12, z + 8]);
const riverForward = riverArea.map(([x, z]) => generate(x, z).serialize().data);
for (let i = riverArea.length - 1; i >= 0; i--) assert.deepEqual(generate(...riverArea[i]).serialize().data, riverForward[i]);
const rivers = new RiverSampler(1337);
let channelSamples = 0;
for (let z = -512; z <= 512; z += 8) for (let x = -512; x <= 512; x += 8) {
  assert(rivers.carveHeight(x, z, 50) <= 50, "rivers never raise an ocean floor");
  if (rivers.strengthAt(x, z) > 0.999) {
    const bed = rivers.carveHeight(x, z, 90);
    assert(bed >= 57 && bed <= 60, "full channel bed depth");
    channelSamples++;
  }
}
assert(channelSamples > 0);
const noise = new PerlinNoise(1337);
for (let i = -1000; i <= 1000; i++) {
  const x = i / 17, y = i / 31, z = -i / 23;
  const n = noise.noise3(x, y, z);
  assert(n >= -1 && n <= 1);
  assert(Math.abs(n - noise.noise3(x + 1e-7, y, z)) < 1e-5);
}
const start = performance.now();
for (let i = 0; i < 256; i++) generate(i % 16 - 8, Math.floor(i / 16) - 8).serialize();
const averageMs = (performance.now() - start) / 256;
console.log(JSON.stringify({ checks: "passed", biomeCounts: Object.fromEntries(biomeCounts), averageMsIncludingSerialize: averageMs }, null, 2));
