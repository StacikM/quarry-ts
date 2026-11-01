import { EditError, MAX_BLOCKS, type Pos, type Region } from "./common";

/** Every function here calls `visit(x, y, z)` once for each block of the shape. A block is never visited twice. */
type Visit = (x: number, y: number, z: number) => void;

export function cuboid(region: Region, visit: Visit): void {
  for (let y = region.min.y; y <= region.max.y; y++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      for (let x = region.min.x; x <= region.max.x; x++) visit(x, y, z);
    }
  }
}

/** The four sides of the box, from the bottom to the top, but not the floor or the roof. */
export function walls(region: Region, visit: Visit): void {
  for (let y = region.min.y; y <= region.max.y; y++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      for (let x = region.min.x; x <= region.max.x; x++) {
        if (x === region.min.x || x === region.max.x || z === region.min.z || z === region.max.z) visit(x, y, z);
      }
    }
  }
}

/** A block is in the sphere when its centre is within the radius (plus half a block, so radius 1 is a 3x3x3 ball). */
export function sphere(center: Pos, radius: number, hollow: boolean, visit: Visit): void {
  const limit = (radius + 0.5) ** 2;
  const inside = (dx: number, dy: number, dz: number): boolean => dx * dx + dy * dy + dz * dz <= limit;
  const reach = Math.ceil(radius);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (!inside(dx, dy, dz)) continue;
        const enclosed = inside(dx + 1, dy, dz) && inside(dx - 1, dy, dz) && inside(dx, dy + 1, dz) && inside(dx, dy - 1, dz) && inside(dx, dy, dz + 1) && inside(dx, dy, dz - 1);
        if (!(hollow && enclosed)) visit(center.x + dx, center.y + dy, center.z + dz);
      }
    }
  }
}

/** A round column going up from `base`. Hollow leaves only the ring: no floor and no roof. */
export function cylinder(base: Pos, radius: number, height: number, hollow: boolean, visit: Visit): void {
  const limit = (radius + 0.5) ** 2;
  const inside = (dx: number, dz: number): boolean => dx * dx + dz * dz <= limit;
  const reach = Math.ceil(radius);
  for (let y = 0; y < height; y++) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (!inside(dx, dz)) continue;
        const enclosed = inside(dx + 1, dz) && inside(dx - 1, dz) && inside(dx, dz + 1) && inside(dx, dz - 1);
        if (!(hollow && enclosed)) visit(base.x + dx, base.y + y, base.z + dz);
      }
    }
  }
}

/** The biggest radius and height a shape may have (a solid one must also fit MAX_BLOCKS). */
export const MAX_RADIUS = 100;
export const MAX_HEIGHT = 256;

export function checkRadius(radius: number): void {
  if (!(radius > 0) || radius > MAX_RADIUS) throw new EditError(`The radius must be more than 0 and at most ${MAX_RADIUS}.`);
}

/** Rough size of a solid ball, to refuse the huge ones before going through all of its blocks. */
export function sphereBlocksEstimate(radius: number, hollow: boolean): number {
  return hollow ? 4 * Math.PI * (radius + 0.5) ** 2 : (4 / 3) * Math.PI * (radius + 0.5) ** 3;
}

export function checkBallSize(radius: number, hollow: boolean): void {
  if (sphereBlocksEstimate(radius, hollow) > MAX_BLOCKS) throw new EditError(`That sphere has too many blocks. The limit is ${MAX_BLOCKS} per edit.`);
}

const NAMED_DIRECTIONS: Record<string, Pos> = {
  n: { x: 0, y: 0, z: -1 }, north: { x: 0, y: 0, z: -1 },
  s: { x: 0, y: 0, z: 1 }, south: { x: 0, y: 0, z: 1 },
  e: { x: 1, y: 0, z: 0 }, east: { x: 1, y: 0, z: 0 },
  w: { x: -1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 },
  u: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 1, z: 0 },
  d: { x: 0, y: -1, z: 0 }, down: { x: 0, y: -1, z: 0 },
};

/**
 * A direction from a word: n, s, e, w, u, d (or the full names), or "me" (the default) for where the player looks.
 * Yaw 0 faces south (+z), 90 west (-x), 180 north (-z), 270 east (+x); a positive pitch looks down.
 */
export function directionFrom(word: string | undefined, look: { yaw: number; pitch: number }): Pos {
  const name = (word ?? "me").toLowerCase();
  if (name !== "me") {
    const direction = NAMED_DIRECTIONS[name];
    if (!direction) throw new EditError(`"${word}" is not a direction. Use n, s, e, w, u, d or me.`);
    return { ...direction };
  }
  if (look.pitch > 50) return { x: 0, y: -1, z: 0 };
  if (look.pitch < -50) return { x: 0, y: 1, z: 0 };
  const yaw = ((look.yaw % 360) + 360) % 360;
  if (yaw >= 315 || yaw < 45) return { x: 0, y: 0, z: 1 };
  if (yaw < 135) return { x: -1, y: 0, z: 0 };
  if (yaw < 225) return { x: 0, y: 0, z: -1 };
  return { x: 1, y: 0, z: 0 };
}
