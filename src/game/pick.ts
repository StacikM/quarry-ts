import { describeState, itemId } from "../world/blockStates";

/** Blocks whose item has another name (the block says "wall_torch", the item "torch"). */
const ITEM_OF_BLOCK: Record<string, string> = {
  wall_torch: "torch",
  soul_wall_torch: "soul_torch",
  redstone_wall_torch: "redstone_torch",
  copper_wall_torch: "copper_torch",
  redstone_wire: "redstone",
  tripwire: "string",
  water: "water_bucket",
  lava: "lava_bucket",
  kelp_plant: "kelp",
  tall_seagrass: "seagrass",
  bamboo_sapling: "bamboo",
  attached_pumpkin_stem: "pumpkin_seeds",
  attached_melon_stem: "melon_seeds",
  pumpkin_stem: "pumpkin_seeds",
  melon_stem: "melon_seeds",
  carrots: "carrot",
  potatoes: "potato",
  beetroots: "beetroot",
  sweet_berry_bush: "sweet_berries",
  cocoa: "cocoa_beans",
  frosted_ice: "ice",
  farmland: "dirt",
  dirt_path: "dirt_path",
};

/** The item that "pick block" (middle click) gives for a block state, or undefined for blocks that have none (air, the portal...). */
export function itemForState(state: number): number | undefined {
  const { name } = describeState(state);
  if (name === "air" || name === "cave_air" || name === "void_air") return undefined;
  const wanted = ITEM_OF_BLOCK[name] ?? name;
  // Wall variants (oak_wall_sign, white_wall_banner, skeleton_wall_skull) share the item of the standing block.
  return itemId(wanted) ?? (name.includes("_wall_") ? itemId(name.replace("_wall_", "_")) : undefined);
}
