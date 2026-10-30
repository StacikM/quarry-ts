import { Block } from "./blocks";
import type { Chunk } from "./Chunk";
import type { TerrainGenerator } from "./TerrainGenerator";

/** The y of the top of the starting platform. Players spawn standing on it. */
export const VOID_PLATFORM_Y = 63;

/**
 * An empty world: nothing but a small stone platform around the spawn, so a
 * lobby can be built from scratch (or a map imported) without any terrain in the way.
 */
export class VoidGenerator implements TerrainGenerator {
  readonly name = "void";

  /** `radius` is how many blocks the platform reaches from the middle block (0,0). */
  constructor(private readonly radius = 3) {}

  generate(chunk: Chunk): void {
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const worldX = chunk.x * 16 + x;
        const worldZ = chunk.z * 16 + z;
        if (Math.abs(worldX) <= this.radius && Math.abs(worldZ) <= this.radius) {
          chunk.setBlock(x, VOID_PLATFORM_Y, z, Block.Stone);
        }
      }
    }
  }
}
