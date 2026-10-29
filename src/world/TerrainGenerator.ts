import type { Chunk } from "./Chunk";

/**
 * CONTRACT between the world and any terrain generator.
 *
 * The world calls generate() once per chunk, the first time someone needs it.
 * The chunk starts empty (all air). Fill it using chunk.setBlock(x, y, z, id, meta)
 * where x and z are 0-15 inside the chunk and y is 0-255.
 *
 * Rules:
 *  - Must be deterministic: same seed + same chunk x/z => identical result.
 *  - Must not read neighbouring chunks (they may not exist yet). Anything that
 *    crosses a chunk border (trees, ore veins) has to be computed from the
 *    seed and world coordinates so both chunks agree without talking.
 */
export interface TerrainGenerator {
  readonly name: string;
  generate(chunk: Chunk): void;
}
