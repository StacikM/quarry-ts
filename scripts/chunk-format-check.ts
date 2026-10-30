/**
 * Reads the chunk bytes we send with prismarine-chunk, a separate implementation of the 1.21 chunk format
 * that we did not write, and compares every block. (The first version of our encoder wrote a length
 * the real client does not expect; a test that used our own reader could not see that.)
 * Run with:  npx tsx scripts/chunk-format-check.ts
 */
import assert from "node:assert";
import { World } from "../src/world/World";
import { createNaturalGenerator } from "../src/world/terrain";
import { encodeChunk } from "../src/protocol/chunkEncoding";
import { stateOf } from "../src/world/blockStates";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require("prismarine-registry")("1.21.11");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ChunkColumn = require("prismarine-chunk")(registry);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Vec3 } = require("vec3");

const world = new World(createNaturalGenerator(1337));
let compared = 0;
for (const [chunkX, chunkZ] of [[0, 0], [3, -2], [-5, 7], [40, 40]]) {
  const chunk = world.getChunk(chunkX, chunkZ);
  // sprinkle in many different blocks, so that some sections need the biggest block format
  for (let i = 0; i < 700; i++) chunk.setBlock(i & 15, 200 + ((i >> 8) & 3), (i >> 4) & 15, 1 + ((i * 37) % 29000));
  chunk.setBlock(5, 255, 5, stateOf("oak_door", { half: "upper", hinge: "right", open: true }));

  const encoded = encodeChunk(chunk.getRawBlocks() as Uint16Array, chunk.getRawBiomes() as Uint8Array, world.getLight(chunk));
  const column = new ChunkColumn({ minY: -64, worldHeight: 384 });
  column.load(encoded.data);
  for (let y = 0; y < 256; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        assert.strictEqual(column.getBlockStateId(new Vec3(x, y, z)), chunk.getState(x, y, z), `chunk ${chunkX},${chunkZ} block ${x},${y},${z}`);
        compared++;
      }
    }
  }
  assert.strictEqual(column.getBlockStateId(new Vec3(0, -1, 0)), 0, "below y=0 is air");
  assert.strictEqual(column.getBlockStateId(new Vec3(0, 300, 0)), 0, "above y=255 is air");
}
console.log(`ok chunk format: prismarine-chunk reads ${compared} blocks of 4 chunks exactly as we wrote them`);
