import type { MinecraftServer } from "./Server";
import type { World } from "../world/World";
import type { BlockPosition } from "../world/BlockPosition";
import { Block } from "../world/blocks";
import { describeState, withProps } from "../world/blockStates";
import { hasSturdyTop, isFullCube } from "../world/blockShapes";

/**
 * Blocks that need something to stand on or hang from: plants, torches, ladders,
 * doors, carpets. When the block they rely on disappears they break too (this
 * server has no items, so nothing is dropped).
 */

/** Blocks that plants may grow on (the vanilla "dirt" tag plus farmland). */
const SOIL = new Set([
  "dirt", "grass_block", "podzol", "coarse_dirt", "mycelium", "rooted_dirt", "moss_block", "pale_moss_block", "mud", "muddy_mangrove_roots", "farmland",
]);
const SAND = new Set(["sand", "red_sand"]);

const FLOWERS = new Set([
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy",
  "cornflower", "lily_of_the_valley", "torchflower", "wither_rose", "open_eyeblossom", "closed_eyeblossom", "short_grass", "fern",
]);
/** Plants two blocks tall: the lower half stands on soil, the upper half on the lower. */
const DOUBLE_PLANTS = new Set(["tall_grass", "large_fern", "sunflower", "lilac", "rose_bush", "peony", "pitcher_plant"]);
const TORCHES = new Set(["torch", "soul_torch", "redstone_torch"]);
const WALL_TORCHES = new Set(["wall_torch", "soul_wall_torch", "redstone_wall_torch"]);

const DIRECTION: Record<string, { x: number; z: number }> = {
  north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 },
};

const NEIGHBORS = [
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

const below = (pos: BlockPosition): BlockPosition => ({ x: pos.x, y: pos.y - 1, z: pos.z });

/** Whether `state` can stay (or be placed) at `pos`, given what is around it. Blocks that need nothing always can. */
export function canSurvive(world: World, pos: BlockPosition, state: number): boolean {
  if (state === Block.Air) return true;
  const { name, properties } = describeState(state);
  const under = (): { name: string; state: number } => {
    const underState = pos.y > 0 ? world.getState(below(pos)) : Block.Air;
    return { name: describeState(underState).name, state: underState };
  };

  if (FLOWERS.has(name) || name.endsWith("_sapling") || name === "mangrove_propagule") return SOIL.has(under().name);
  if (name === "dead_bush") {
    const base = under().name;
    return SOIL.has(base) || SAND.has(base) || base === "terracotta" || base.endsWith("_terracotta");
  }
  if (DOUBLE_PLANTS.has(name) || name === "door" || name.endsWith("_door")) {
    if (properties.half === "upper") {
      const lower = describeState(world.getState(below(pos)));
      return lower.name === name && lower.properties.half === "lower";
    }
    const base = under();
    return name.endsWith("door") ? hasSturdyTop(base.state) : SOIL.has(base.name);
  }
  if (name === "sugar_cane") {
    const base = under().name;
    return base === "sugar_cane" || SOIL.has(base) || SAND.has(base);
  }
  if (name === "cactus") {
    const base = under().name;
    return base === "cactus" || SAND.has(base);
  }
  if (TORCHES.has(name) || name.endsWith("_carpet") || name.endsWith("_pressure_plate") || name === "rail" || name === "snow") {
    return hasSturdyTop(under().state);
  }
  if (WALL_TORCHES.has(name) || name === "ladder") {
    const direction = DIRECTION[properties.facing];
    if (!direction) return true;
    return isFullCube(world.getState({ x: pos.x - direction.x, y: pos.y, z: pos.z - direction.z }));
  }
  return true;
}

/** The lower half of a two-block plant whose upper half is gone. (Placing puts both halves in, so this only happens after a break.) */
function lacksUpperHalf(world: World, pos: BlockPosition, state: number): boolean {
  const { name, properties } = describeState(state);
  if (!DOUBLE_PLANTS.has(name) || properties.half !== "lower") return false;
  return world.getState({ x: pos.x, y: pos.y + 1, z: pos.z }) === Block.Air;
}

/** The upper half to place along with a lower half, for two-block plants (tall grass, sunflowers...). */
export function upperHalfOf(state: number): number | undefined {
  const { name, properties } = describeState(state);
  return DOUBLE_PLANTS.has(name) && properties.half === "lower" ? withProps(state, { half: "upper" }) : undefined;
}

/**
 * Call after the block at `pos` was removed or replaced: every neighbor that can no
 * longer stay is broken, and so on for whatever hung on those (a flower on top of
 * a sugar cane stalk on top of the block you broke...).
 */
export function breakUnsupported(server: MinecraftServer, pos: BlockPosition): void {
  const queue: BlockPosition[] = [pos];
  for (let handled = 0; queue.length > 0 && handled < 512; handled++) {
    const at = queue.shift()!;
    for (const step of NEIGHBORS) {
      const neighbor = { x: at.x + step.x, y: at.y + step.y, z: at.z + step.z };
      if (neighbor.y < 0 || neighbor.y > 255) continue;
      const state = server.world.getState(neighbor);
      if (state === Block.Air || (canSurvive(server.world, neighbor, state) && !lacksUpperHalf(server.world, neighbor, state))) continue;
      server.setBlock(neighbor, Block.Air);
      queue.push(neighbor);
    }
  }
}
