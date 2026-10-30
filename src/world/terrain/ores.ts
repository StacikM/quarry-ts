import { Block } from "../blocks";
import type { Chunk } from "../Chunk";
import { hash2, mulberry32 } from "./random";

const ORES = [
  { id: Block.CoalOre, max: 127, chance: 0.65, size: 12 },
  { id: Block.IronOre, max: 63, chance: 0.5, size: 9 },
  { id: Block.GoldOre, max: 31, chance: 0.25, size: 7 },
  { id: Block.RedstoneOre, max: 15, chance: 0.35, size: 8 },
  { id: Block.DiamondOre, max: 15, chance: 0.12, size: 6 },
  { id: Block.LapisOre, max: 31, chance: 0.16, size: 6 },
];

/** Each 8-cube cell owns a bounded vein; replay border cells in both chunks. */
export function placeOres(chunk: Chunk, seed: number): void {
  const originX = chunk.x * 16, originZ = chunk.z * 16;
  for (const ore of ORES) {
    for (let cz = chunk.z * 2 - 1; cz <= chunk.z * 2 + 2; cz++) {
      for (let cx = chunk.x * 2 - 1; cx <= chunk.x * 2 + 2; cx++) {
        for (let cy = 0; cy <= Math.floor(ore.max / 8); cy++) {
          const random = mulberry32(hash2(seed ^ Math.imul(cy, 734287) ^ ore.id, cx, cz));
          if (random() > ore.chance) continue;
          const rootX = cx * 8 + Math.floor(random() * 8);
          const rootY = cy * 8 + Math.floor(random() * 8);
          const rootZ = cz * 8 + Math.floor(random() * 8);
          let wx = rootX, y = rootY, wz = rootZ;
          for (let i = 0; i < ore.size; i++) {
            const x = wx - originX, z = wz - originZ;
            if (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 5 && y <= ore.max
              && chunk.getState(x, y, z) === Block.Stone) chunk.setBlock(x, y, z, ore.id);
            const axis = Math.floor(random() * 3), step = random() < 0.5 ? -1 : 1;
            // Bound each vein to two blocks beyond its anchor cell.
            if (axis === 0) wx = Math.max(rootX - 2, Math.min(rootX + 2, wx + step));
            if (axis === 1) y = Math.max(rootY - 2, Math.min(rootY + 2, y + step));
            if (axis === 2) wz = Math.max(rootZ - 2, Math.min(rootZ + 2, wz + step));
          }
        }
      }
    }
  }
}
