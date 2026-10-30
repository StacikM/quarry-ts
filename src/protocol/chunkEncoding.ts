/**
 * Turns a chunk into the bytes of the 1.21.11 "Chunk Data and Update Light" packet.
 *
 * The client's world is 384 blocks tall (y -64 to 319), cut into 24 sections of
 * 16 blocks. Our chunks only hold y 0 to 255, which are sections 4 to 19, so the
 * rest is sent as air (and full sunlight above the build limit).
 *
 * Each section stores its blocks as a "paletted container": a short list of the
 * distinct block states in the section (the palette) and, for every block, which
 * palette entry it is, packed into as few bits as possible. A section with one
 * kind of block (all air, all stone) is just that block's number.
 */
import { encodeVarInt } from "../network/VarInt";
import { packLight, type ChunkLight } from "../world/lighting";
import { BIOME_COUNT } from "../world/biomeIds";
import { STATE_COUNT } from "../world/blockStates";

export const WORLD_MIN_Y = -64;
export const SECTIONS = 24; // sections in the client's world
/** The index of the first section we store: y 0 is section 4. */
const FIRST_STORED = -WORLD_MIN_Y / 16;
const STORED_SECTIONS = 16;

const BLOCK_DIRECT_BITS = Math.ceil(Math.log2(STATE_COUNT)); // 15: used when a section has too many kinds of block for a palette
const BIOME_DIRECT_BITS = Math.ceil(Math.log2(BIOME_COUNT));

/** Collects bytes; VarInts and longs are what paletted containers are made of. */
class ByteSink {
  private readonly parts: Buffer[] = [];
  varInt(value: number): void {
    this.parts.push(encodeVarInt(value));
  }
  byte(value: number): void {
    this.parts.push(Buffer.from([value]));
  }
  short(value: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value);
    this.parts.push(b);
  }
  bytes(buffer: Buffer): void {
    this.parts.push(buffer);
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

// palette lookup, reused between sections: state -> palette index, -1 when not seen yet
const paletteIndex = new Int16Array(1 << 16).fill(-1);

/**
 * Writes `values` (block states or biome IDs) as a paletted container.
 * `maxPaletteBits` is the largest palette size (in bits) the format allows before
 * it switches to storing the raw values with `directBits` each.
 */
function writeContainer(out: ByteSink, values: ArrayLike<number>, minPaletteBits: number, maxPaletteBits: number, directBits: number): void {
  const palette: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (paletteIndex[value] < 0) {
      paletteIndex[value] = palette.length;
      palette.push(value);
    }
  }

  try {
    if (palette.length === 1) {
      out.byte(0); // zero bits per entry: the whole section is this one value
      out.varInt(palette[0]); // and nothing else: since 1.21.5 the data array has no length in front of it, and here it is empty
      return;
    }

    const indirectBits = Math.max(minPaletteBits, Math.ceil(Math.log2(palette.length)));
    const direct = indirectBits > maxPaletteBits;
    const bits = direct ? directBits : indirectBits;

    out.byte(bits);
    if (!direct) {
      out.varInt(palette.length);
      for (const value of palette) out.varInt(value);
    }

    // Entries are packed from the low bits of each 64-bit number upwards, and never split across two numbers.
    const perLong = Math.floor(64 / bits);
    const longCount = Math.ceil(values.length / perLong);
    const data = Buffer.alloc(longCount * 8);
    for (let long = 0; long < longCount; long++) {
      let low = 0; // bits 0-31 of this long
      let high = 0; // bits 32-63
      const first = long * perLong;
      const last = Math.min(values.length, first + perLong);
      for (let i = first; i < last; i++) {
        const entry = direct ? values[i] : paletteIndex[values[i]];
        const shift = (i - first) * bits;
        if (shift + bits <= 32) {
          low |= entry << shift;
        } else if (shift >= 32) {
          high |= entry << (shift - 32);
        } else {
          low |= entry << shift; // the part that fits below bit 32 (the rest overflows away)
          high |= entry >>> (32 - shift);
        }
      }
      data.writeUInt32BE(high >>> 0, long * 8);
      data.writeUInt32BE(low >>> 0, long * 8 + 4);
    }
    out.bytes(data); // the number of longs follows from the bits per entry, so no length is sent
  } finally {
    for (const value of palette) paletteIndex[value] = -1;
  }
}

/** The "heightmaps" the client expects: for each column, how high the highest block reaches. */
function heightmap(blocks: Uint16Array): bigint[] {
  const BITS = 9; // heights go up to 384
  const PER_LONG = Math.floor(64 / BITS);
  const longs = new Array<bigint>(Math.ceil(256 / PER_LONG)).fill(0n);
  for (let column = 0; column < 256; column++) {
    let y = 255;
    while (y >= 0 && blocks[(y << 8) | column] === 0) y--;
    const value = BigInt(y + 1 - WORLD_MIN_Y); // 0 would mean "nothing at all"
    const long = Math.floor(column / PER_LONG);
    longs[long] |= value << BigInt((column % PER_LONG) * BITS);
  }
  return longs;
}

export interface EncodedChunk {
  /** Heightmaps by type number (1 = world surface, 4 = motion blocking). */
  heightmaps: Array<{ type: number; data: bigint[] }>;
  data: Buffer;
  skyLightMask: bigint;
  blockLightMask: bigint;
  emptySkyLightMask: bigint;
  emptyBlockLightMask: bigint;
  skyLight: Buffer[];
  blockLight: Buffer[];
}

export function encodeChunk(blocks: Uint16Array, biomes: Uint8Array, light: ChunkLight): EncodedChunk {
  const out = new ByteSink();
  const biomeCells = new Uint8Array(64);

  for (let section = 0; section < SECTIONS; section++) {
    const stored = section - FIRST_STORED;
    if (stored < 0 || stored >= STORED_SECTIONS) {
      out.short(0);
      writeContainer(out, [0], 4, 8, BLOCK_DIRECT_BITS);
      writeContainer(out, [biomes[0]], 1, 3, BIOME_DIRECT_BITS);
      continue;
    }

    const values = blocks.subarray(stored * 4096, (stored + 1) * 4096);
    let solid = 0;
    for (let i = 0; i < 4096; i++) if (values[i] !== 0) solid++;
    out.short(solid);
    writeContainer(out, values, 4, 8, BLOCK_DIRECT_BITS);

    // Biomes are stored in 4x4x4 cells; we pick the column in the middle of each cell, for every height.
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const biome = biomes[((cz * 4 + 2) << 4) | (cx * 4 + 2)];
        for (let cy = 0; cy < 4; cy++) biomeCells[(cy << 4) | (cz << 2) | cx] = biome;
      }
    }
    writeContainer(out, biomeCells, 1, 3, BIOME_DIRECT_BITS);
  }

  // Light has one more section below and above the world: bit N is section N - 1.
  const storedSections = Array.from({ length: STORED_SECTIONS }, (_, i) => i);
  const sky = packLight(light.sky, storedSections);
  const block = packLight(light.block, storedSections);
  const skyLight: Buffer[] = [];
  const blockLight: Buffer[] = [];
  let skyLightMask = 0n;
  let blockLightMask = 0n;
  let emptySkyLightMask = 0n;
  let emptyBlockLightMask = 0n;
  const fullSky = Buffer.alloc(2048, 0xff);

  for (let bit = 0; bit < SECTIONS + 2; bit++) {
    const stored = bit - 1 - FIRST_STORED;
    const flag = 1n << BigInt(bit);
    if (stored < 0) {
      // below y = 0: nothing there, no light
      emptySkyLightMask |= flag;
      emptyBlockLightMask |= flag;
    } else if (stored < STORED_SECTIONS) {
      skyLightMask |= flag;
      skyLight.push(sky.subarray(stored * 2048, (stored + 1) * 2048));
      blockLightMask |= flag;
      blockLight.push(block.subarray(stored * 2048, (stored + 1) * 2048));
    } else {
      // above the build limit: open sky
      skyLightMask |= flag;
      skyLight.push(fullSky);
      emptyBlockLightMask |= flag;
    }
  }

  const surface = heightmap(blocks);
  return {
    heightmaps: [
      { type: 1, data: surface },
      { type: 4, data: surface },
    ],
    data: out.toBuffer(),
    skyLightMask,
    blockLightMask,
    emptySkyLightMask,
    emptyBlockLightMask,
    skyLight,
    blockLight,
  };
}
