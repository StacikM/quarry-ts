import { EMISSION_TABLE, OPACITY_TABLE } from "./lightData";

/**
 * Light levels (0-15) for every block of a chunk, indexed like Chunk's blocks:
 * (y << 8) | (z << 4) | x.
 */
export interface ChunkLight {
  sky: Uint8Array;
  block: Uint8Array;
}

/**
 * Column heights of the four chunks next to this one (index (z << 4) | x), or
 * null if unknown. They let sunlight shine in sideways across a chunk border.
 */
export interface NeighborHeights {
  west: Int16Array | null; // chunk x - 1
  east: Int16Array | null; // chunk x + 1
  north: Int16Array | null; // chunk z - 1
  south: Int16Array | null; // chunk z + 1
}

const NO_NEIGHBORS: NeighborHeights = { west: null, east: null, north: null, south: null };
const CELLS = 16 * 16 * 256;

/**
 * Works out sky light and block light for a chunk using the same rules as
 * the Minecraft client:
 *
 *  - A block with nothing opaque above it ("open sky") has sky light 15.
 *  - Light spreads to the six neighbouring blocks, losing max(1, opacity of
 *    the block it enters). So it fades by 1 per block in air, 3 per block in
 *    water, and solid blocks stop it completely.
 *  - Block light starts at a block's own emission (lava, torches...) and
 *    spreads the same way.
 *
 * Why match the client's rules so exactly? The client re-checks the light of
 * every chunk it receives and quietly fixes anything that disagrees with its
 * own rules. If our numbers already agree, those checks cost nothing; if they
 * don't, the client does a lot of work and the world looks wrong for seconds.
 *
 * Limitation: light is only followed inside this chunk. Sunlight entering
 * from a neighbour is handled using the neighbour's column heights, but a
 * lava lake in the next chunk does not light this one.
 */
export function computeLight(
  blocks: Uint16Array,
  heights: Int16Array,
  neighbors: NeighborHeights = NO_NEIGHBORS,
): ChunkLight {
  const sky = new Uint8Array(CELLS);
  const block = new Uint8Array(CELLS);
  const queue: number[] = [];

  // ---- Sky light: open sky first, then spread what spills into shadow.
  for (let column = 0; column < 256; column++) {
    for (let y = heights[column]; y < 256; y++) sky[(y << 8) | column] = 15;
  }

  for (let column = 0; column < 256; column++) {
    const x = column & 15;
    const z = column >> 4;
    const height = heights[column];

    const west = x > 0 ? heights[column - 1] : neighbors.west ? neighbors.west[(z << 4) | 15] : -1;
    const east = x < 15 ? heights[column + 1] : neighbors.east ? neighbors.east[z << 4] : -1;
    const north = z > 0 ? heights[column - 16] : neighbors.north ? neighbors.north[(15 << 4) | x] : -1;
    const south = z < 15 ? heights[column + 16] : neighbors.south ? neighbors.south[x] : -1;

    // Lit blocks that sit next to a taller column can push light sideways into it.
    // The block right at `height` also pushes light down into the top block.
    const tallestNeighbor = Math.max(west, east, north, south);
    const last = Math.min(255, Math.max(height, tallestNeighbor - 1));
    for (let y = height; y <= last; y++) queue.push((y << 8) | column);

    // Light arriving from a neighbouring chunk's open sky, into blocks below our own surface.
    const outside = [
      x === 0 && neighbors.west ? west : -1,
      x === 15 && neighbors.east ? east : -1,
      z === 0 && neighbors.north ? north : -1,
      z === 15 && neighbors.south ? south : -1,
    ];
    const outsideHeight = Math.min(...outside.map((h) => (h >= 0 ? h : 256)));
    for (let y = outsideHeight; y < height; y++) {
      const cell = (y << 8) | column;
      const value = 15 - Math.max(1, OPACITY_TABLE[blocks[cell] >> 4]);
      if (value > sky[cell]) {
        sky[cell] = value;
        queue.push(cell);
      }
    }
  }
  spread(sky, blocks, queue);

  // ---- Block light: start from every glowing block.
  queue.length = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const emission = EMISSION_TABLE[blocks[cell] >> 4];
    if (emission > 0) {
      block[cell] = emission;
      queue.push(cell);
    }
  }
  spread(block, blocks, queue);

  return { sky, block };
}

/** Breadth-first spread of light from the cells in `queue`, following the rules above. */
function spread(light: Uint8Array, blocks: Uint16Array, queue: number[]): void {
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const value = light[cell];
    if (value <= 1) continue;

    const x = cell & 15;
    const z = (cell >> 4) & 15;
    const y = cell >> 8;

    if (x > 0) enter(cell - 1, value);
    if (x < 15) enter(cell + 1, value);
    if (z > 0) enter(cell - 16, value);
    if (z < 15) enter(cell + 16, value);
    if (y > 0) enter(cell - 256, value);
    if (y < 255) enter(cell + 256, value);
  }

  function enter(neighbor: number, from: number): void {
    const next = from - Math.max(1, OPACITY_TABLE[blocks[neighbor] >> 4]);
    if (next > light[neighbor]) {
      light[neighbor] = next;
      queue.push(neighbor);
    }
  }
}

/**
 * Packs light levels for the given sections into the protocol's format:
 * 4 bits per block, two blocks per byte, the even-numbered block in the low half.
 */
export function packLight(light: Uint8Array, sections: number[]): Buffer {
  const packed = Buffer.alloc(sections.length * 2048);
  let offset = 0;
  for (const section of sections) {
    const start = section * 4096;
    for (let i = 0; i < 4096; i += 2) {
      packed[offset++] = light[start + i] | (light[start + i + 1] << 4);
    }
  }
  return packed;
}
