import { describeState, stateOf, withProps } from "../world/blockStates";

/**
 * Working out which block state to place. The item only says "oak stairs"; whether
 * they face north or south, and whether they are upside down, depends on where the
 * player stands and which part of which face they clicked.
 */

/** The wall version of each standing torch (vanilla names them inconsistently). */
const WALL_TORCH: Record<string, string> = { torch: "wall_torch", soul_torch: "soul_wall_torch", redstone_torch: "redstone_wall_torch" };

// The four horizontal directions numbered like Minecraft does: 0 south, 1 west, 2 north, 3 east.
const HORIZONTAL = ["south", "west", "north", "east"] as const;
const OPPOSITE: Record<string, string> = { south: "north", north: "south", west: "east", east: "west", up: "down", down: "up" };
/** The face numbers the client sends (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east) as direction names. */
const FACE_NAMES = ["down", "up", "north", "south", "west", "east"] as const;

/** Blocks that a block can be placed into, replacing them (instead of being placed next to them). */
const REPLACEABLE = new Set([
  "air", "cave_air", "void_air", "water", "lava", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "seagrass", "tall_seagrass",
  "fire", "soul_fire", "vine", "glow_lichen", "snow", "light",
]);

export function isReplaceable(state: number): boolean {
  const { name, properties } = describeState(state);
  if (name === "snow") return properties.layers === "1"; // only a single layer of snow gives way
  return REPLACEABLE.has(name);
}

/** The direction a player looks, from their yaw angle (0 degrees = south, 90 = west). */
export function playerDirection(yaw: number): string {
  return HORIZONTAL[Math.floor(yaw / 90 + 0.5) & 3];
}

/** Applies properties if the block has them; otherwise leaves the state alone. */
function adjust(state: number, props: Record<string, string | boolean>): number {
  const have = describeState(state).properties;
  const usable: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key in have) usable[key] = value;
  }
  try {
    return withProps(state, usable);
  } catch {
    return state;
  }
}

/**
 * The state to place for `base` (the item's block, in its default state).
 * `face` is the face of the clicked block (0-5), `cursor` where on it the click was (0-1 in each direction).
 * Returns null if this block cannot be placed that way (for example a torch on a ceiling).
 */
export function placementState(base: number, face: number, cursor: { x: number; y: number; z: number }, yaw: number): number | null {
  const { name, properties } = describeState(base);
  const facing = playerDirection(yaw);
  const clickedHigh = face === 0 || (face > 1 && cursor.y > 0.5);

  // Wall torches are separate blocks from standing ones.
  if (name === "torch" || name === "soul_torch" || name === "redstone_torch") {
    if (face === 0) return null;
    if (face === 1) return base;
    return stateOf(WALL_TORCH[name], { facing: FACE_NAMES[face] });
  }
  if (name === "ladder") {
    return face >= 2 ? adjust(base, { facing: FACE_NAMES[face] }) : null;
  }

  if (name.endsWith("_stairs")) {
    return adjust(base, { facing, half: clickedHigh ? "top" : "bottom" });
  }
  if (name.endsWith("_slab")) {
    return adjust(base, { type: clickedHigh ? "top" : "bottom" });
  }
  if ("axis" in properties) {
    return adjust(base, { axis: face <= 1 ? "y" : face <= 3 ? "z" : "x" });
  }
  if ("facing" in properties) {
    // Furnaces, chests, pistons...: the front faces the player.
    return adjust(base, { facing: OPPOSITE[facing] });
  }
  return base;
}
