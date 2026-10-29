/**
 * How each block affects light, taken from Minecraft 1.8.9.
 *
 * Opacity: how much light a block removes when light passes through it.
 *   0   = see-through (air, glass, plants, cactus, doors...)
 *   1-3 = leaves/cobweb 1, water and ice 3
 *   255 = solid, stops all light
 * Light also loses 1 for every step it travels, even through air, so the
 * real cost of entering a block is max(1, opacity).
 *
 * Emission: the light level (0-15) a block gives off by itself.
 *
 * Blocks not listed as see-through are treated as solid. That is exactly
 * right for stone, dirt, wood and so on, and a harmless approximation for
 * unusual shapes.
 */

const OPACITY = new Uint8Array(256).fill(255);

function setOpacity(value: number, blockIds: number[]): void {
  for (const id of blockIds) OPACITY[id] = value;
}

setOpacity(0, [
  0, // air
  6, // sapling
  10, 11, // lava
  20, // glass
  26, // bed
  27, 28, 66, // rails
  31, 32, // tall grass, dead bush
  34, // piston head
  37, 38, 39, 40, // flowers, mushrooms
  50, 51, // torch, fire
  54, 146, // chests
  55, // redstone wire
  59, 141, 142, // crops
  63, 68, // signs
  64, 71, 193, 194, 195, 196, 197, // doors
  65, // ladder
  69, 77, 143, // lever, buttons
  70, 72, 147, 148, // pressure plates
  75, 76, // redstone torches
  78, // snow layer
  81, // cactus
  83, // sugar cane
  85, 113, 188, 189, 190, 191, 192, // fences
  90, 119, // portals
  92, // cake
  93, 94, // repeaters
  95, 160, // stained glass and panes
  96, 167, // trapdoors
  101, 102, // iron bars, glass pane
  106, // vines
  107, 183, 184, 185, 186, 187, // fence gates
  111, // lily pad
  115, // nether wart
  117, 118, // brewing stand, cauldron
  122, // dragon egg
  131, 132, // tripwire
  139, // cobblestone wall
  140, // flower pot
  144, // skull
  145, // anvil
  149, 150, // comparators
  151, 178, // daylight sensors
  154, // hopper
  166, // barrier
  171, // carpet
  175, // double plants
  176, 177, // banners
  198, // end rod
]);
setOpacity(1, [18, 161, 30]); // leaves, cobweb
setOpacity(3, [8, 9, 79]); // water, ice

const EMISSION = new Uint8Array(256);

function setEmission(level: number, blockIds: number[]): void {
  for (const id of blockIds) EMISSION[id] = level;
}

setEmission(15, [10, 11, 51, 89, 91, 124, 138, 169, 119]); // lava, fire, glowstone, jack o'lantern, lit lamp, beacon, sea lantern, end portal
setEmission(14, [50, 198]); // torch, end rod
setEmission(13, [62]); // lit furnace
setEmission(11, [90]); // nether portal
setEmission(9, [74, 94]); // lit redstone ore, powered repeater
setEmission(7, [76, 130]); // redstone torch, ender chest
setEmission(1, [39, 117, 122]); // brown mushroom, brewing stand, dragon egg

/** How much light the block removes (0-255). */
export function lightOpacity(blockId: number): number {
  return OPACITY[blockId & 0xff];
}

/** The light level the block gives off (0-15). */
export function lightEmission(blockId: number): number {
  return EMISSION[blockId & 0xff];
}

/** Direct lookup tables for hot loops. Index with the block id (0-255). Do not modify. */
export const OPACITY_TABLE: Readonly<Uint8Array> = OPACITY;
export const EMISSION_TABLE: Readonly<Uint8Array> = EMISSION;
