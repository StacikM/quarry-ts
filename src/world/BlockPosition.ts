/** The integer coordinates of a single block in the world. */
export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * When the client clicks a block it tells us which face it clicked (0-5).
 * Placing a block puts it next to that face, so this is the offset to add.
 */
export const FACE_OFFSETS: Record<number, BlockPosition> = {
  0: { x: 0, y: -1, z: 0 }, // bottom
  1: { x: 0, y: 1, z: 0 }, // top
  2: { x: 0, y: 0, z: -1 }, // north
  3: { x: 0, y: 0, z: 1 }, // south
  4: { x: -1, y: 0, z: 0 }, // west
  5: { x: 1, y: 0, z: 0 }, // east
};
