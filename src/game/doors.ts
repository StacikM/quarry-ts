import type { MinecraftServer } from "./Server";
import type { World } from "../world/World";
import type { BlockPosition } from "../world/BlockPosition";
import { Block } from "../world/blocks";
import { defaultState, describeState, withProps } from "../world/blockStates";
import { hasSturdyTop, isFullCube } from "../world/blockShapes";

/**
 * Doors, following the 1.21 rules.
 *
 * A door is TWO blocks tall. Both halves are the same block, told apart by their
 * properties:
 *   half   = lower | upper
 *   facing = north | south | west | east   (the way the player who placed it looked)
 *   hinge  = left | right                  (which side it swings from)
 *   open   = true | false
 * Both halves keep the same facing, hinge and open values, so toggling means changing both.
 */

const DIRECTIONS = [
  { name: "south", x: 0, z: 1 },
  { name: "west", x: -1, z: 0 },
  { name: "north", x: 0, z: -1 },
  { name: "east", x: 1, z: 0 },
];

/** Blocks a door may be placed into, as if they were air. */
const REPLACEABLE = new Set(["air", "cave_air", "void_air", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "snow"]);

/** The name of the block a state belongs to, e.g. "oak_door". */
function nameOf(state: number): string {
  return describeState(state).name;
}

export function isDoorBlock(state: number): boolean {
  return nameOf(state).endsWith("_door");
}

/** Iron doors only open with redstone, which this server does not have. */
export function canOpenByHand(state: number): boolean {
  return nameOf(state) !== "iron_door";
}

/** The door block that an item places, or undefined if the item is not a door. */
export function doorFor(itemName: string | undefined): string | undefined {
  return itemName?.endsWith("_door") ? itemName : undefined;
}

/** The direction a player looks, from their yaw angle (0 degrees = south, 90 = west), as an index into DIRECTIONS. */
function directionFromYaw(yaw: number): number {
  return Math.floor(yaw / 90 + 0.5) & 3;
}

export interface DoorPlan {
  position: BlockPosition; // the lower half
  lower: number; // the state to place there
  upper: number; // and above it
}

/**
 * Works out whether a door can be placed at `target` (the lower half) and how
 * it would look, without changing anything. Returns null if it can't go there.
 * `cursorX/Z` is where on the block the player clicked (0-1), which picks the hinge side.
 */
export function planDoor(
  world: World,
  target: BlockPosition,
  doorName: string,
  playerYaw: number,
  cursor: { x: number; z: number } = { x: 0.5, z: 0.5 },
): DoorPlan | null {
  if (target.y < 0 || target.y > 254) return null; // the upper half sits one higher, so 255 is the last block

  const below = { x: target.x, y: target.y - 1, z: target.z };
  const above = up(target);
  if (!hasSturdyTop(world.getState(below))) return null; // needs something to stand on
  if (!REPLACEABLE.has(nameOf(world.getState(target))) || !REPLACEABLE.has(nameOf(world.getState(above)))) return null;

  const facing = directionFromYaw(playerYaw);
  const direction = DIRECTIONS[facing];
  const hinge = hingeSide(world, target, doorName, facing, cursor);

  const base = defaultState(doorName);
  const props = { facing: direction.name, hinge, open: false, powered: false };
  return {
    position: target,
    lower: withProps(base, { ...props, half: "lower" }),
    upper: withProps(base, { ...props, half: "upper" }),
  };
}

/**
 * Vanilla's hinge rule: next to a wall or an existing door so double doors line
 * up; otherwise by which half of the block you clicked.
 */
function hingeSide(world: World, target: BlockPosition, doorName: string, facing: number, cursor: { x: number; z: number }): "left" | "right" {
  const left = DIRECTIONS[(facing + 3) & 3]; // counter-clockwise from the way the player looks, seen from above
  const right = DIRECTIONS[(facing + 1) & 3];
  const leftPos = offset(target, left);
  const rightPos = offset(target, right);

  const wall = (pos: BlockPosition): number => Number(isFullCube(world.getState(pos))) + Number(isFullCube(world.getState(up(pos))));
  const balance = wall(rightPos) - wall(leftPos);
  const isLowerDoor = (pos: BlockPosition): boolean => {
    const state = world.getState(pos);
    return nameOf(state) === doorName && describeState(state).properties.half === "lower";
  };
  const leftDoor = isLowerDoor(leftPos);
  const rightDoor = isLowerDoor(rightPos);

  if ((leftDoor && !rightDoor) || balance > 0) return "right";
  if ((rightDoor && !leftDoor) || balance < 0) return "left";

  const direction = DIRECTIONS[facing];
  const rightSideClicked =
    (direction.x < 0 && cursor.z < 0.5) || (direction.x > 0 && cursor.z > 0.5) || (direction.z < 0 && cursor.x > 0.5) || (direction.z > 0 && cursor.x < 0.5);
  return rightSideClicked ? "right" : "left";
}

/** Puts both halves in the world and tells every player. */
export function placeDoor(server: MinecraftServer, plan: DoorPlan): void {
  server.setBlock(plan.position, plan.lower);
  server.setBlock(up(plan.position), plan.upper);
}

/** Opens a closed door or closes an open one. `pos` can be either half. */
export function toggleDoor(server: MinecraftServer, pos: BlockPosition): void {
  const world = server.world;
  const state = world.getState(pos);
  const isUpper = describeState(state).properties.half === "upper";
  const lowerPos = isUpper ? down(pos) : pos;
  const upperPos = up(lowerPos);

  const lower = world.getState(lowerPos);
  const upper = world.getState(upperPos);
  if (nameOf(lower) !== nameOf(state) || nameOf(upper) !== nameOf(state)) return; // a half is missing

  const open = describeState(lower).properties.open !== "true";
  server.setBlock(lowerPos, withProps(lower, { open }));
  server.setBlock(upperPos, withProps(upper, { open }));
}

/**
 * Call after a door block was broken: removes the other half too, so you
 * never get half a door floating in the air. `state` is the state that was broken.
 */
export function removeOtherDoorHalf(server: MinecraftServer, pos: BlockPosition, state: number): void {
  const isUpper = describeState(state).properties.half === "upper";
  const other = isUpper ? down(pos) : up(pos);
  const otherState = server.world.getState(other);
  if (nameOf(otherState) !== nameOf(state)) return;
  if ((describeState(otherState).properties.half === "upper") === isUpper) return; // same half: not ours

  server.setBlock(other, Block.Air);
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
