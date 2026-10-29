/**
 * A chunk is a 16 x 256 x 16 column of blocks.
 *
 * For sending, it's split into 16 "sections" stacked on top of each other,
 * each 16 x 16 x 16. Sections that are all air are skipped, which is why
 * flat worlds are cheap to send.
 */

import { isTransparent } from "./blocks";

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

  /** The y of the highest block in each column that blocks sunlight (-1 if none). */
  private findSkyHeights(): Int16Array {
    const heights = new Int16Array(256).fill(-1);
    for (let column = 0; column < 256; column++) {
      for (let y = 255; y >= 0; y--) {
        if (!isTransparent(this.blocks[(y << 8) | column] >> 4)) {
          heights[column] = y;
          break;
        }
      }
    }
    return heights;
  }

  /**
   * Simple sunlight: a block is fully lit (15) if nothing opaque is above it,
   * otherwise it is dark (0). Real Minecraft also spreads light sideways, so
   * cave mouths look a bit harsh here, but caves and overhangs do get dark.
   *
   * Light is stored as 4 bits per block: two blocks per byte, the block with
   * the even index in the low half.
   */
  private buildSkyLight(sections: number[]): Buffer {
    const heights = this.findSkyHeights();
    const light = Buffer.alloc((sections.length * BLOCKS_PER_SECTION) / 2);
    let nibble = 0;

    for (const s of sections) {
      for (let i = 0; i < BLOCKS_PER_SECTION; i++, nibble++) {
        const y = s * 16 + (i >> 8);
        const column = i & 0xff;
        if (y > heights[column]) {
          light[nibble >> 1] |= (nibble & 1) === 0 ? 0x0f : 0xf0;
        }
      }
    }
    return light;
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
  serialize(): { sectionMask: number; data: Buffer } {
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

    // We have no light sources, so block light is 0 everywhere.
    const blockLight = Buffer.alloc(sections.length * BLOCKS_PER_SECTION / 2, 0x00);
    const skyLight = this.buildSkyLight(sections);
    const biomes = Buffer.from(this.biomes);

    let sectionMask = 0;
    for (const s of sections) sectionMask |= 1 << s;

    return { sectionMask, data: Buffer.concat([blockData, blockLight, skyLight, biomes]) };
  }
}
