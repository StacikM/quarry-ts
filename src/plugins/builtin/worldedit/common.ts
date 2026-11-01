/** A block position, or a direction when its numbers are -1, 0 or 1. */
export interface Pos {
  x: number;
  y: number;
  z: number;
}

/** A box of blocks; both corners are inside it. */
export interface Region {
  min: Pos;
  max: Pos;
}

/** The most blocks one edit may look at or change. It keeps a typo from freezing the server. */
export const MAX_BLOCKS = 250_000;

/** The build height of the world: blocks exist from y = 0 to y = 255. */
export const MIN_Y = 0;
export const MAX_Y = 255;

/** A mistake the player made (an unknown block, no selection...). The message is shown to them as it is. */
export class EditError extends Error {}

export function regionSize(region: Region): Pos {
  return {
    x: region.max.x - region.min.x + 1,
    y: region.max.y - region.min.y + 1,
    z: region.max.z - region.min.z + 1,
  };
}

export function regionVolume(region: Region): number {
  const size = regionSize(region);
  return size.x * size.y * size.z;
}

/** Throws when a region is too big to edit. */
export function checkVolume(region: Region): void {
  if (regionVolume(region) > MAX_BLOCKS) {
    throw new EditError(`That is too many blocks (${regionVolume(region)}). The limit is ${MAX_BLOCKS} per edit.`);
  }
}

export function posText(pos: Pos): string {
  return `${pos.x}, ${pos.y}, ${pos.z}`;
}
