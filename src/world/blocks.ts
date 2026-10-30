import { stateOf, STATE_COUNT } from './blockStates';

/** Modern Java 1.21.11 STATE ids, not block registry ids or legacy id/meta pairs. */
export const Block = {
  Air: stateOf('air'), Stone: stateOf('stone'), Grass: stateOf('grass_block'),
  Dirt: stateOf('dirt'), Bedrock: stateOf('bedrock'), Water: stateOf('water'), Lava: stateOf('lava'),
  Sand: stateOf('sand'), Gravel: stateOf('gravel'),
  GoldOre: stateOf('gold_ore'), IronOre: stateOf('iron_ore'), CoalOre: stateOf('coal_ore'),
  Log: stateOf('oak_log', {axis:'y'}), Leaves: stateOf('oak_leaves', {persistent:true, distance:1}),
  SpruceLog: stateOf('spruce_log', {axis:'y'}), SpruceLeaves: stateOf('spruce_leaves', {persistent:true, distance:1}),
  BirchLog: stateOf('birch_log', {axis:'y'}), BirchLeaves: stateOf('birch_leaves', {persistent:true, distance:1}),
  LapisOre: stateOf('lapis_ore'), DiamondOre: stateOf('diamond_ore'), RedstoneOre: stateOf('redstone_ore'),
  Snow: stateOf('snow', {layers:1}), TallGrass: stateOf('short_grass'),
  DeadBush: stateOf('dead_bush'), Dandelion: stateOf('dandelion'), Poppy: stateOf('poppy'),
  Cactus: stateOf('cactus'), SugarCane: stateOf('sugar_cane'),
} as const;

/** Maximum valid state, retained under the old public constant name. */
export const MAX_BLOCK_ID = STATE_COUNT - 1;
export const TREE_LOGS: ReadonlySet<number> = new Set([Block.Log, Block.SpruceLog, Block.BirchLog]);
export const TREE_LEAVES: ReadonlySet<number> = new Set([Block.Leaves, Block.SpruceLeaves, Block.BirchLeaves]);
// State-indexed light opacity/emission lives in lightData.ts.
