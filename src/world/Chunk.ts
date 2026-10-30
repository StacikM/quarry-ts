/**
 * A chunk is a 16 x 256 x 16 column of blocks.
 *
 * Every block is stored as its "block state" number: one number that says both
 * which block it is and how it is set (an oak door facing north, open, lower half...).
 * It is the same number the Minecraft protocol uses, so nothing needs converting
 * on the way to the player. See blockStates.ts to turn names into numbers.
 *
 * For sending (protocol/chunkEncoding.ts) the column is split into 16 sections
 * of 16 x 16 x 16 blocks.
 */

import { OPACITY_TABLE } from "./lightData";
import { biomeId } from "./biomeIds";
import type { ChunkLight } from "./lighting";

const SECTION_COUNT = 16;
const BLOCKS_PER_SECTION = 16 * 16 * 16; // 4096
const BIOME_PLAINS = biomeId("plains");

export class Chunk {
  /**
   * Every block in the chunk, as a block state number (0 is air).
   *
   * The index is (y << 8) | (z << 4) | x, which means y is the "slowest"
   * changing coordinate. That's the same order the protocol uses, and it
   * means section N is simply indexes N*4096 up to (N+1)*4096.
   */
  private readonly blocks = new Uint16Array(SECTION_COUNT * BLOCKS_PER_SECTION);

  /** One biome ID per column, indexed (z << 4) | x. Starts as plains. */
  private readonly biomes = new Uint8Array(256).fill(BIOME_PLAINS);

  constructor(
    readonly x: number,
    readonly z: number,
  ) {}

  /** x and z here are 0-15 (inside this chunk), y is 0-255. */
  private static index(x: number, y: number, z: number): number {
    return (y << 8) | (z << 4) | x;
  }

  /** The block state at this spot. */
  getState(x: number, y: number, z: number): number {
    return this.blocks[Chunk.index(x, y, z)];
  }

  /** Used by terrain generators. Not saved: the generator can recreate it. */
  setBlock(x: number, y: number, z: number, state: number): void {
    this.blocks[Chunk.index(x, y, z)] = state;
  }

  /**
   * Blocks changed after generation (by players or plugins), as
   * index -> state. These are what gets saved to disk.
   */
  private readonly edits = new Map<number, number>();
  /** True if `edits` has changed since it was last saved. */
  dirty = false;

  /** Like setBlock, but remembers the change so it is saved. */
  editBlock(x: number, y: number, z: number, state: number): void {
    const index = Chunk.index(x, y, z);
    this.blocks[index] = state;
    this.edits.set(index, state);
    this.dirty = true;
    this.heightMap = null;
    this.light = null;
  }

  getEdits(): ReadonlyMap<number, number> {
    return this.edits;
  }

  /** Re-applies saved edits on top of freshly generated terrain. Does not mark the chunk dirty. */
  applyEdits(saved: ReadonlyMap<number, number>): void {
    for (const [index, state] of saved) {
      this.blocks[index] = state;
      this.edits.set(index, state);
    }
  }

  /** x and z are 0-15. The ID is the biome's number, see biomeIds.ts. */
  setBiome(x: number, z: number, biome: number): void {
    this.biomes[(z << 4) | x] = biome;
  }

  getBiome(x: number, z: number): number {
    return this.biomes[(z << 4) | x];
  }

  /** The biome of every column, indexed (z << 4) | x. Read-only. */
  getRawBiomes(): Readonly<Uint8Array> {
    return this.biomes;
  }

  /**
   * The chunk's blocks as stored: block state numbers, indexed (y << 8) | (z << 4) | x.
   * Read-only: change blocks with setBlock / editBlock.
   */
  getRawBlocks(): Readonly<Uint16Array> {
    return this.blocks;
  }

  private heightMap: Int16Array | null = null;

  /**
   * For each column (index (z << 4) | x): the y just above the highest block
   * that stops or dims light. Everything at or above that y sees the open sky.
   * Cactus, glass, plants and air do not count; leaves and water do.
   */
  getHeightMap(): Int16Array {
    if (this.heightMap) return this.heightMap;

    const heights = new Int16Array(256);
    for (let column = 0; column < 256; column++) {
      let y = 255;
      while (y >= 0 && OPACITY_TABLE[this.blocks[(y << 8) | column]] === 0) y--;
      heights[column] = y + 1;
    }
    return (this.heightMap = heights);
  }

  /**
   * Light for this chunk, worked out by World.getLight() (it needs the
   * neighbouring chunks) and kept here until a block changes.
   */
  light: ChunkLight | null = null;

  /**
   * Roughly how many bytes of memory this chunk uses: the blocks, the light
   * (only once it has been computed) and everything else (biomes, column
   * heights, the list of edits). An estimate, not an exact figure.
   */
  memoryBreakdown(): { blockBytes: number; lightBytes: number; otherBytes: number } {
    return {
      blockBytes: this.blocks.byteLength,
      lightBytes: this.light ? this.light.sky.byteLength + this.light.block.byteLength : 0,
      otherBytes: this.biomes.byteLength + (this.heightMap?.byteLength ?? 0) + this.edits.size * 40,
    };
  }

  /** Forget the stored light so it is recomputed next time it is needed. */
  invalidateLight(): void {
    this.light = null;
  }
}
