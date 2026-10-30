/**
 * Checks propagation consistency for Quarry's state-indexed lighting model.
 * Water attenuation is currently the requested compatibility value 3; modern
 * source data uses 1. This is not an independent proof of full vanilla fidelity.
 * Run with:  npx tsx scripts/lighting-check.ts
 *
 * The client re-checks the light of every chunk it receives. Where our numbers
 * disagree with its rules it does a lot of corrective work (the world looks
 * wrong for seconds and the game lags), so "does every block's light equal
 * what the rules give from its neighbours" is the property that matters.
 */
import assert from "node:assert";
import { Chunk } from "../src/world/Chunk";
import { World } from "../src/world/World";
import { computeLight } from "../src/world/lighting";
import { lightEmission, lightOpacity } from "../src/world/lightData";
import { createNaturalGenerator } from "../src/world/terrain";
import { Block } from "../src/world/blocks";

const index = (x: number, y: number, z: number): number => (y << 8) | (z << 4) | x;

/** A chunk with a solid floor (stone up to y=63), otherwise air. */
function flatChunk(): Chunk {
  const chunk = new Chunk(0, 0);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 64; y++) chunk.setBlock(x, y, z, Block.Stone);
  return chunk;
}

function light(chunk: Chunk) {
  return computeLight(chunk.getRawBlocks() as Uint16Array, chunk.getHeightMap());
}

// ---------------------------------------------------------------- basics
{
  const { sky, block } = light(flatChunk());
  assert.strictEqual(sky[index(8, 64, 8)], 15, "air above the ground is full sunlight");
  assert.strictEqual(sky[index(8, 200, 8)], 15);
  assert.strictEqual(sky[index(8, 30, 8)], 0, "inside solid rock is dark");
  assert.strictEqual(block[index(8, 64, 8)], 0, "no light sources, no block light");
  console.log("ok open sky is 15, rock is 0");
}

// The bug you saw: cactus must not block light.
{
  const chunk = flatChunk();
  chunk.setBlock(8, 63, 8, Block.Sand);
  for (const y of [64, 65, 66]) chunk.setBlock(8, y, 8, Block.Cactus);
  const { sky } = light(chunk);
  for (const y of [64, 65, 66]) assert.strictEqual(sky[index(8, y, 8)], 15, `cactus at y=${y} must be fully lit`);
  assert.strictEqual(sky[index(8, 67, 8)], 15);
  // ...which is why the top face of a cactus was black before: the block above it read as dark.
  console.log("ok cactus does not block sunlight");
}

// ---------------------------------------------------------------- spreading
{
  // A roof over the whole east part of the chunk: the only way in for light is from the open west side,
  // so it fades 1 per block going in.
  const chunk = flatChunk();
  for (let x = 4; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlock(x, 66, z, Block.Stone); // roof, 2 above ground
  const { sky } = light(chunk);
  // Row z=8 under the roof, entering from the open west side at x=3 (open sky at x<4).
  const levels = [4, 5, 6, 7, 8, 9].map((x) => sky[index(x, 64, 8)]);
  assert.deepStrictEqual(levels, [14, 13, 12, 11, 10, 9], "light should fade by 1 per block under a roof");
  assert.strictEqual(sky[index(8, 66, 8)], 0, "the roof itself is solid");
  console.log("ok light fades one level per block into shadow:", levels.join(" "));
}
{
  // Water takes 3 per block.
  const chunk = flatChunk();
  for (let y = 59; y < 64; y++) chunk.setBlock(8, y, 8, Block.Air); // a shaft 5 deep...
  for (let y = 59; y < 64; y++) chunk.setBlock(8, y, 8, Block.Water); // ...filled with water
  const { sky } = light(chunk);
  const levels = [63, 62, 61, 60, 59].map((y) => sky[index(8, y, 8)]);
  assert.deepStrictEqual(levels, [12, 9, 6, 3, 0], "water removes 3 light per block");
  console.log("ok water absorbs 3 per block:", levels.join(" "));
}
{
  // Leaves remove 1 extra per block of canopy.
  const chunk = flatChunk();
  chunk.setBlock(8, 66, 8, Block.Leaves);
  const { sky } = light(chunk);
  assert.strictEqual(sky[index(8, 66, 8)], 14, "the leaf block under open sky is 14");
  assert.strictEqual(sky[index(8, 65, 8)], 14, "light under a single leaf is mostly restored from the sides");
  console.log("ok leaves dim light slightly");
}
{
  // Lava glows and lights its surroundings.
  const chunk = flatChunk();
  for (let x = 6; x < 11; x++) for (let z = 6; z < 11; z++) for (let y = 20; y < 24; y++) chunk.setBlock(x, y, z, Block.Air); // sealed cave
  chunk.setBlock(8, 20, 8, Block.Lava);
  const { block, sky } = light(chunk);
  assert.strictEqual(block[index(8, 20, 8)], 15, "lava itself is 15");
  assert.strictEqual(block[index(8, 21, 8)], 14);
  assert.strictEqual(block[index(8, 23, 8)], 12);
  assert.strictEqual(sky[index(8, 22, 8)], 0, "a sealed cave gets no sunlight");
  console.log("ok lava lights a cave (block light 15, 14, ...)");
}

// ---------------------------------------------------------------- the client's own rules on real terrain
{
  const world = new World(createNaturalGenerator(1337));
  let cells = 0;
  const problems: string[] = [];

  // Chunks around origin plus an area with oceans, rivers, snow and caves.
  const areas: Array<[number, number]> = [];
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) areas.push([cx, cz]);
  for (let cx = 8; cx <= 12; cx++) for (let cz = 8; cz <= 12; cz++) areas.push([cx, cz]);
  for (let cx = -14; cx <= -10; cx++) for (let cz = 3; cz <= 7; cz++) areas.push([cx, cz]);

  for (const [cx, cz] of areas) {
    const chunk = world.getChunk(cx, cz);
    const { sky, block } = world.getLight(chunk);
    const blocks = chunk.getRawBlocks();
    const heights = chunk.getHeightMap();

    for (let y = 0; y < 256; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const i = index(x, y, z);
      const id = blocks[i];
      const opacity = lightOpacity(id);
      const onBorder = x === 0 || x === 15 || z === 0 || z === 15;
      if (onBorder) continue; // border blocks also depend on the next chunk; checked separately below
      cells++;

      // What the client computes: open sky = 15, otherwise the best neighbour minus the cost of entering.
      const neighbors = [i - 1, i + 1, i - 16, i + 16, y > 0 ? i - 256 : -1, y < 255 ? i + 256 : -1].filter((n) => n >= 0);
      const entering = Math.max(1, opacity);
      const bestSky = Math.max(0, ...neighbors.map((n) => sky[n] - entering));
      const expectedSky = y >= heights[(z << 4) | x] ? 15 : bestSky;
      if (sky[i] !== expectedSky) problems.push(`sky ${cx},${cz} (${x},${y},${z}) id ${id}: have ${sky[i]}, rules say ${expectedSky}`);

      const bestBlock = Math.max(0, ...neighbors.map((n) => block[n] - entering));
      const expectedBlock = Math.max(lightEmission(id), bestBlock);
      if (block[i] !== expectedBlock) problems.push(`block ${cx},${cz} (${x},${y},${z}) id ${id}: have ${block[i]}, rules say ${expectedBlock}`);
      if (problems.length > 12) break;
    }
    assert.ok(problems.length === 0, `light disagrees with the client's rules:\n  ${problems.slice(0, 12).join("\n  ")}`);
  }
  console.log(`ok ${cells.toLocaleString()} blocks in ${areas.length} real chunks satisfy the configured lighting model`);

  // Across chunk borders we only know the neighbour's column heights, not its light, so a few blocks next to a
  // border (mostly tree canopies that cross it) are off by a level or two. That is a known limit; it must stay tiny.
  let litPairs = 0;
  let jumps = 0;
  for (const [cx, cz] of areas) {
    const chunk = world.getChunk(cx, cz);
    const east = world.getChunk(cx + 1, cz);
    const sky = world.getLight(chunk).sky;
    const skyEast = world.getLight(east).sky;
    for (let y = 0; y < 256; y++) for (let z = 0; z < 16; z++) {
      const a = sky[index(15, y, z)];
      const b = skyEast[index(0, y, z)];
      if (a === 0 && b === 0) continue;
      litPairs++;
      const cost = Math.max(1, lightOpacity(chunk.getRawBlocks()[index(15, y, z)]), lightOpacity(east.getRawBlocks()[index(0, y, z)]));
      if (Math.abs(a - b) > cost && Math.min(a, b) > 0) jumps++;
    }
  }
  const percent = (100 * jumps) / litPairs;
  assert.ok(percent < 0.2, `too many light jumps across chunk borders: ${jumps} of ${litPairs} (${percent.toFixed(3)}%)`);
  console.log(`ok across chunk borders ${jumps} of ${litPairs.toLocaleString()} lit block pairs (${percent.toFixed(3)}%) differ by more than one step (known limit)`);
}

// ---------------------------------------------------------------- editing
{
  const world = new World(createNaturalGenerator(1337));
  const chunk = world.getChunk(0, 0);
  const ground = world.getSpawnHeight(8, 8); // first free block above the surface
  const before = world.getLight(chunk);
  assert.strictEqual(before, world.getLight(chunk), "light is cached between calls");

  world.setBlock({ x: 8, y: ground, z: 8 }, Block.Stone);
  world.setBlock({ x: 8, y: ground + 3, z: 8 }, Block.Stone); // a roof over the block below
  const after = world.getLight(chunk);
  assert.notStrictEqual(before, after, "editing a block must discard the cached light");
  assert.ok(after.sky[index(8, ground + 1, 8)] < 15, "a block placed overhead must shade what is under it");

  // And an edit on a chunk border invalidates the neighbour's light too.
  const east = world.getChunk(1, 0);
  const eastLight = world.getLight(east);
  world.setBlock({ x: 15, y: ground + 10, z: 5 }, Block.Stone);
  assert.notStrictEqual(world.getLight(east), eastLight, "an edit on a border must refresh the neighbouring chunk");
  console.log("ok editing blocks refreshes light (including across borders)");
}

// ---------------------------------------------------------------- cost
{
  const world = new World(createNaturalGenerator(1337));
  const chunks: Chunk[] = [];
  for (let cx = 30; cx < 43; cx++) for (let cz = 30; cz < 43; cz++) chunks.push(world.getChunk(cx, cz));
  const started = process.hrtime.bigint();
  for (const chunk of chunks) world.getLight(chunk);
  const perChunk = Number(process.hrtime.bigint() - started) / 1e6 / chunks.length;
  console.log(`info light for a chunk: ${perChunk.toFixed(2)} ms (under tsx, includes generating border neighbours)`);
  assert.ok(perChunk < 25, "lighting a chunk is unexpectedly slow");
}

console.log("ALL LIGHTING CHECKS PASS");
