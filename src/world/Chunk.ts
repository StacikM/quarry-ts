/**
 * A chunk is a 16 x 256 x 16 column of blocks.
 *
 * For sending, it's split into 16 "sections" stacked on top of each other,
 * each 16 x 16 x 16. Sections that are all air are skipped, which is why
 * flat worlds are cheap to send.
 */

import { OPACITY_TABLE } from "./lightData";
import { computeLight, packLight, type ChunkLight } from "./lighting";

const SECTION_COUNT = 16;
const BLOCKS_PER_SECTION = 16 * 16 * 16; // 4096
const BIOME_PLAINS = 1;

export class Chunk {
  /**
   * Every block in the chunk, stored as (blockId << 4) | metadata.
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

  getBlockId(x: number, y: number, z: number): number {
    return this.blocks[Chunk.index(x, y, z)] >> 4;
  }

  getBlockMetadata(x: number, y: number, z: number): number {
    return this.blocks[Chunk.index(x, y, z)] & 0xf;
  }

  /** Used by terrain generators. Not saved: the generator can recreate it. */
  setBlock(x: number, y: number, z: number, blockId: number, metadata = 0): void {
    this.blocks[Chunk.index(x, y, z)] = (blockId << 4) | (metadata & 0xf);
  }

  /**
   * Blocks changed after generation (by players or plugins), as
   * index -> state. These are what gets saved to disk.
   */
  private readonly edits = new Map<number, number>();
  /** True if `edits` has changed since it was last saved. */
  dirty = false;

  /** Like setBlock, but remembers the change so it is saved. */
  editBlock(x: number, y: number, z: number, blockId: number, metadata = 0): void {
    const index = Chunk.index(x, y, z);
    const state = (blockId << 4) | (metadata & 0xf);
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

  /** x and z are 0-15. IDs: 1 plains, 2 desert, 4 forest, 12 ice plains, 3 extreme hills... */
  setBiome(x: number, z: number, biomeId: number): void {
    this.biomes[(z << 4) | x] = biomeId;
  }

  getBiome(x: number, z: number): number {
    return this.biomes[(z << 4) | x];
  }

  private isSectionEmpty(section: number): boolean {
    const start = section * BLOCKS_PER_SECTION;
    for (let i = start; i < start + BLOCKS_PER_SECTION; i++) {
      if (this.blocks[i] !== 0) return false;
    }
    return true;
  }

  /**
   * The chunk's blocks as stored: (blockId << 4) | metadata, indexed (y << 8) | (z << 4) | x.
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
      while (y >= 0 && OPACITY_TABLE[this.blocks[(y << 8) | column] >> 4] === 0) y--;
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

  /**
   * Turns the chunk into the bytes the 1.8 Chunk Data packet wants.
   *
   * `sectionMask` has bit N set if section N is included. The data is:
   *   1. block states of every included section (2 bytes each, little-endian!)
   *   2. block light of every included section  (half a byte per block)
   *   3. sky light of every included section    (half a byte per block)
   *   4. 256 biome IDs (one per x/z column)
   */
  serialize(light?: ChunkLight): { sectionMask: number; data: Buffer } {
    // Callers that don't have the neighbouring chunks (tests, tools) get light
    // computed from this chunk alone. The server passes World.getLight(chunk).
    const lit = light ?? computeLightAlone(this);

    const sections: number[] = [];
    for (let s = 0; s < SECTION_COUNT; s++) {
      if (!this.isSectionEmpty(s)) sections.push(s);
    }

    const blockData = Buffer.alloc(sections.length * BLOCKS_PER_SECTION * 2);
    let offset = 0;
    for (const s of sections) {
      const start = s * BLOCKS_PER_SECTION;
      for (let i = start; i < start + BLOCKS_PER_SECTION; i++) {
        offset = blockData.writeUInt16LE(this.blocks[i], offset);
      }
    }

    const blockLight = packLight(lit.block, sections);
    const skyLight = packLight(lit.sky, sections);
    const biomes = Buffer.from(this.biomes);

    let sectionMask = 0;
    for (const s of sections) sectionMask |= 1 << s;

    return { sectionMask, data: Buffer.concat([blockData, blockLight, skyLight, biomes]) };
  }
}

function computeLightAlone(chunk: Chunk): ChunkLight {
  return computeLight(chunk.getRawBlocks() as Uint16Array, chunk.getHeightMap());
}
