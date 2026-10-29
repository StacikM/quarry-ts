import type { MinecraftServer } from "./Server";
import type { World } from "../world/World";
import type { BlockPosition } from "../world/BlockPosition";
import { Block } from "../world/blocks";
import { lightOpacity } from "../world/lightData";

/**
 * Doors, following the 1.8.9 rules.
 *
 * A door is TWO blocks tall. Each half has its own block id (the same for both)
 * and metadata:
 *   lower half: bits 0-1 = which way it faces, bit 2 (value 4) = open
 *   upper half: bit 3 (value 8) marks it as the upper half,
 *               bit 0 (value 1) = hinge on the right instead of the left
 * Only the lower half stores "open"; the client reads it from there for both.
 */

/** What you hold in your hand (an item id above 255) -> the block it places. */
export const DOOR_ITEM_TO_BLOCK: Readonly<Record<number, number>> = {
  324: 64, // oak door
  330: 71, // iron door
  427: 193, // spruce door
  428: 194, // birch door
  429: 195, // jungle door
  430: 196, // acacia door
  431: 197, // dark oak door
};

const DOOR_BLOCKS = new Set(Object.values(DOOR_ITEM_TO_BLOCK));
const IRON_DOOR = 71;
const UPPER_HALF = 8;
const OPEN = 4;

/** Blocks a door may be placed into, as if they were air. */
const REPLACEABLE = new Set<number>([Block.Air, 31, 32]); // air, tall grass, dead bush

export function isDoorBlock(blockId: number): boolean {
  return DOOR_BLOCKS.has(blockId);
}

/** Iron doors only open with redstone, which this server does not have. */
export function canOpenByHand(blockId: number): boolean {
  return blockId !== IRON_DOOR;
}

// The four horizontal directions, numbered the way Minecraft numbers them: 0 south, 1 west, 2 north, 3 east.
const DIRECTIONS = [
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
];

/** The direction a player looks, from their yaw angle. 0 degrees = south, 90 = west. */
function directionFromYaw(yaw: number): number {
  return Math.floor(yaw / 90 + 0.5) & 3;
}

export interface DoorPlan {
  position: BlockPosition; // the lower half
  blockId: number;
  lowerMeta: number;
  upperMeta: number;
}

/**
 * Works out whether a door can be placed at `target` (the lower half) and how
 * it would look, without changing anything. Returns null if it can't go there.
 */
export function planDoor(world: World, target: BlockPosition, blockId: number, playerYaw: number): DoorPlan | null {
  if (target.y < 1 || target.y > 253) return null;

  const below = { x: target.x, y: target.y - 1, z: target.z };
  const upper = { x: target.x, y: target.y + 1, z: target.z };
  if (!isSolid(world, below)) return null; // needs something to stand on
  if (!REPLACEABLE.has(world.getBlockId(target)) || !REPLACEABLE.has(world.getBlockId(upper))) return null;

  // Hinge: vanilla puts it next to a wall or an existing door so double doors line up.
  const facing = directionFromYaw(playerYaw);
  const rightSide = offset(target, DIRECTIONS[(facing + 1) & 3]);
  const leftSide = offset(target, DIRECTIONS[(facing + 3) & 3]);
  const solidAt = (pos: BlockPosition): number => Number(isSolid(world, pos)) + Number(isSolid(world, up(pos)));
  const hasDoorAt = (pos: BlockPosition): boolean => world.getBlockId(pos) === blockId || world.getBlockId(up(pos)) === blockId;

  const hingeRight = (hasDoorAt(leftSide) && !hasDoorAt(rightSide)) || solidAt(rightSide) > solidAt(leftSide);

  return {
    position: target,
    blockId,
    lowerMeta: (facing + 1) & 3,
    upperMeta: UPPER_HALF | (hingeRight ? 1 : 0),
  };
}

/** Puts both halves in the world and tells every player. */
export function placeDoor(server: MinecraftServer, plan: DoorPlan): void {
  server.setBlock(plan.position, plan.blockId, plan.lowerMeta);
  server.setBlock(up(plan.position), plan.blockId, plan.upperMeta);
}

/** Opens a closed door or closes an open one. `pos` can be either half. */
export function toggleDoor(server: MinecraftServer, pos: BlockPosition): void {
  const world = server.world;
  const blockId = world.getBlockId(pos);
  const lower = world.getBlockMetadata(pos) & UPPER_HALF ? down(pos) : pos;

  if (world.getBlockId(lower) !== blockId) return; // the other half is missing
  const meta = world.getBlockMetadata(lower);
  if (meta & UPPER_HALF) return;

  server.setBlock(lower, blockId, meta ^ OPEN);
}

/**
 * Call after a door block was broken: removes the other half too, so you
 * never get half a door floating in the air.
 */
export function removeOtherDoorHalf(server: MinecraftServer, pos: BlockPosition, blockId: number, meta: number): void {
  const other = meta & UPPER_HALF ? down(pos) : up(pos);
  const world = server.world;
  if (world.getBlockId(other) !== blockId) return;
  if (Boolean(world.getBlockMetadata(other) & UPPER_HALF) === Boolean(meta & UPPER_HALF)) return; // same half: not ours

  server.setBlock(other, Block.Air, 0);
}

function isSolid(world: World, pos: BlockPosition): boolean {
  const id = world.getBlockId(pos);
  return id !== Block.Air && lightOpacity(id) === 255;
}

function offset(pos: BlockPosition, direction: { x: number; z: number }): BlockPosition {
  return { x: pos.x + direction.x, y: pos.y, z: pos.z + direction.z };
}

function up(pos: BlockPosition): BlockPosition {
  return { x: pos.x, y: pos.y + 1, z: pos.z };
}

function down(pos: BlockPosition): BlockPosition {
  return { x: pos.x, y: pos.y - 1, z: pos.z };
}
