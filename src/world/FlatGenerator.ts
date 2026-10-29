import { Block } from "./blocks";
import type { Chunk } from "./Chunk";
import type { TerrainGenerator } from "./TerrainGenerator";

/**
 * The layers of our flat world, from the bottom up.
 * Change this to make a different flat world (e.g. add more stone).
 */
const LAYERS = [Block.Bedrock, Block.Dirt, Block.Dirt, Block.Grass];

export class FlatGenerator implements TerrainGenerator {
  readonly name = "flat";

  generate(chunk: Chunk): void {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        LAYERS.forEach((blockId, y) => chunk.setBlock(x, y, z, blockId));
      }
    }
  }
}
