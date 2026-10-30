import type { MinecraftServer } from "./Server";
import type { World } from "../world/World";
import type { BlockPosition } from "../world/BlockPosition";
import { Block } from "../world/blocks";
import { hasSolidTopSurface, isDoorBlock, isNormalCube } from "./doors";

/**
 * Blocks that need something to stand on or hang from: plants, torches, ladders, doors, carpets.
 * When the block they rely on disappears they break too (this server has no items, so nothing is dropped),
 * and they cannot be placed where they could not stay.
 */

const FARMLAND = 60;
const SAPLING = 6;
const TORCH = 50;
const REDSTONE_WIRE = 55;
const WHEAT = 59;
const LADDER = 65;
const RAIL = 66;
const STONE_PRESSURE_PLATE = 70;
const WOODEN_PRESSURE_PLATE = 72;
const POWERED_RAIL = 27;
const DETECTOR_RAIL = 28;
const REDSTONE_TORCH_OFF = 75;
const REDSTONE_TORCH_ON = 76;
const LEAVES = 18;
const LEAVES2 = 161;
const REPEATER_OFF = 93;
const REPEATER_ON = 94;
const COMPARATOR_OFF = 149;
const COMPARATOR_ON = 150;
const LIGHT_PRESSURE_PLATE = 147;
const HEAVY_PRESSURE_PLATE = 148;
const CARROTS = 141;
const POTATOES = 142;
const STAINED_CLAY = 159;
const ACTIVATOR_RAIL = 157;
const CARPET = 171;
const HARDENED_CLAY = 172;
const DOUBLE_PLANT = 175;
const UPPER_HALF = 8; // metadata bit of the top half of a door or a two-block plant

/** Plants that grow on dirt, grass and farmland. */
const SOIL_PLANTS = new Set<number>([SAPLING, Block.TallGrass, Block.Dandelion, Block.Poppy]);
const CROPS = new Set<number>([WHEAT, CARROTS, POTATOES]);
const TORCHES = new Set<number>([TORCH, REDSTONE_TORCH_OFF, REDSTONE_TORCH_ON]);
/** Blocks that need a solid top surface under them. */
const FLAT_ON_FLOOR = new Set<number>([
  CARPET, REDSTONE_WIRE, RAIL, POWERED_RAIL, DETECTOR_RAIL, ACTIVATOR_RAIL,
  STONE_PRESSURE_PLATE, WOODEN_PRESSURE_PLATE, LIGHT_PRESSURE_PLATE, HEAVY_PRESSURE_PLATE,
  REPEATER_OFF, REPEATER_ON, COMPARATOR_OFF, COMPARATOR_ON,
]);

const NEIGHBORS = [
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

/**
 * Where a torch or ladder hangs: the block it is attached to, as a step from the torch/ladder.
 * Torch metadata 1-4 is the direction the torch leans (east, west, south, north); a ladder's 2-5 is the direction it faces (north, south, west, east).
 */
const TORCH_WALL: Record<number, { x: number; z: number }> = { 1: { x: -1, z: 0 }, 2: { x: 1, z: 0 }, 3: { x: 0, z: -1 }, 4: { x: 0, z: 1 } };
const LADDER_WALL: Record<number, { x: number; z: number }> = { 2: { x: 0, z: 1 }, 3: { x: 0, z: -1 }, 4: { x: 1, z: 0 }, 5: { x: -1, z: 0 } };

const below = (pos: BlockPosition): BlockPosition => ({ x: pos.x, y: pos.y - 1, z: pos.z });
const above = (pos: BlockPosition): BlockPosition => ({ x: pos.x, y: pos.y + 1, z: pos.z });

/**
 * The metadata a block gets when a player places it against `face` (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east),
 * or null when it cannot be placed on that face (a torch under a ceiling, a ladder on the floor).
 * `damage` is what the item says (the colour of wool, the kind of sapling...).
 */
export function placementMetadata(blockId: number, face: number, damage: number): number | null {
  if (TORCHES.has(blockId)) {
    if (face === 0) return null;
    return face === 1 ? 5 : { 2: 4, 3: 3, 4: 2, 5: 1 }[face] ?? null;
  }
  if (blockId === LADDER) return face >= 2 && face <= 5 ? face : null;
  return damage & 0xf;
}

/** Whether a block of this kind can stay (or be put) at `pos`, given what is around it. Blocks that need nothing always can. */
export function canSurvive(world: World, pos: BlockPosition, blockId: number, meta: number): boolean {
  if (blockId === Block.Air) return true;
  const under = below(pos);
  const underId = pos.y > 0 ? world.getBlockId(under) : Block.Air;

  if (SOIL_PLANTS.has(blockId)) return underId === Block.Grass || underId === Block.Dirt || underId === FARMLAND;
  if (CROPS.has(blockId)) return underId === FARMLAND;
  if (blockId === Block.DeadBush) return underId === Block.Sand || underId === HARDENED_CLAY || underId === STAINED_CLAY || underId === Block.Dirt;
  if (blockId === Block.SugarCane) return underId === Block.SugarCane || underId === Block.Grass || underId === Block.Dirt || underId === Block.Sand;
  if (blockId === Block.Cactus) return underId === Block.Cactus || underId === Block.Sand;

  if (blockId === DOUBLE_PLANT) {
    if ((meta & UPPER_HALF) !== 0) return underId === DOUBLE_PLANT && (world.getBlockMetadata(under) & UPPER_HALF) === 0;
    return underId === Block.Grass || underId === Block.Dirt || underId === FARMLAND;
  }
  if (isDoorBlock(blockId)) {
    if ((meta & UPPER_HALF) !== 0) return underId === blockId && (world.getBlockMetadata(under) & UPPER_HALF) === 0;
    return hasSolidTopSurface(world, under);
  }

  if (TORCHES.has(blockId)) {
    const wall = TORCH_WALL[meta];
    if (wall) return isNormalCube(world, { x: pos.x + wall.x, y: pos.y, z: pos.z + wall.z });
    return hasSolidTopSurface(world, under);
  }
  if (blockId === LADDER) {
    const wall = LADDER_WALL[meta];
    return wall === undefined || isNormalCube(world, { x: pos.x + wall.x, y: pos.y, z: pos.z + wall.z });
  }
  if (FLAT_ON_FLOOR.has(blockId)) return hasSolidTopSurface(world, under);
  if (blockId === Block.Snow) return hasSolidTopSurface(world, under) || underId === LEAVES || underId === LEAVES2 || isNormalCube(world, under);
  return true;
}

/** The lower half of a two-block plant whose upper half is gone. (Placing puts both halves in, so this only happens after a break.) */
function lacksUpperHalf(world: World, pos: BlockPosition, blockId: number, meta: number): boolean {
  return blockId === DOUBLE_PLANT && (meta & UPPER_HALF) === 0 && world.getBlockId(above(pos)) !== DOUBLE_PLANT;
}

/** The two-block plants: the metadata of the upper half to place along with the lower one, or null. */
export function upperHalfMetadata(blockId: number, lowerMeta: number): number | null {
  return blockId === DOUBLE_PLANT && (lowerMeta & UPPER_HALF) === 0 ? UPPER_HALF : null;
}

/**
 * Call after the block at `pos` was removed or replaced: every neighbor that can no longer stay is broken, and
 * so on for whatever hung on those (a flower on top of a sugar cane stalk on top of the block you broke...).
 */
export function breakUnsupported(server: MinecraftServer, pos: BlockPosition): void {
  const world = server.world;
  const queue: BlockPosition[] = [pos];
  for (let handled = 0; queue.length > 0 && handled < 512; handled++) {
    const at = queue.shift()!;
    for (const step of NEIGHBORS) {
      const neighbor = { x: at.x + step.x, y: at.y + step.y, z: at.z + step.z };
      if (neighbor.y < 0 || neighbor.y > 255) continue;
      const id = world.getBlockId(neighbor);
      if (id === Block.Air) continue;
      const meta = world.getBlockMetadata(neighbor);
      if (canSurvive(world, neighbor, id, meta) && !lacksUpperHalf(world, neighbor, id, meta)) continue;
      server.setBlock(neighbor, Block.Air);
      queue.push(neighbor);
    }
  }
}
