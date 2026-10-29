/**
 * A few block IDs from 1.8. A block is an ID plus 4 bits of "metadata"
 * (for example wool is ID 35, and the metadata picks the colour).
 *
 * Anything 0-255 is a block; 256 and up are items (swords, food, ...)
 * that can't be placed.
 */
export const Block = {
  Air: 0,
  Stone: 1,
  Grass: 2,
  Dirt: 3,
  Bedrock: 7,
  Water: 9,
  Lava: 11,
  Sand: 12,
  Gravel: 13,
  GoldOre: 14,
  IronOre: 15,
  CoalOre: 16,
  Log: 17,
  Leaves: 18,
  LapisOre: 21,
  DiamondOre: 56,
  RedstoneOre: 73,
  Snow: 78,
  TallGrass: 31,
  DeadBush: 32,
  Dandelion: 37,
  Poppy: 38,
  Cactus: 81,
  SugarCane: 83,
} as const;

export const MAX_BLOCK_ID = 255;

/**
 * Blocks that let sunlight through. Used for lighting: everything above the
 * highest block that is NOT in this list is lit; everything below is dark.
 * Add an id here when you add a see-through block (glass, leaves, ...).
 */
const TRANSPARENT_BLOCKS = new Set<number>([
  0, // air
  8, // flowing water
  9, // still water
  18, // leaves
  20, // glass
  31, // tall grass
  32, // dead bush
  37, // dandelion
  38, // rose
  78, // snow layer
  83, // sugar cane
]);

export function isTransparent(blockId: number): boolean {
  return TRANSPARENT_BLOCKS.has(blockId);
}
