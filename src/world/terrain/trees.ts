import { Block } from "../blocks";
import type { Chunk } from "../Chunk";
import { Biome } from "./biomes";
import { hash2 } from "./random";

export interface TreeTerrain {
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number): number;
}

/** Replay roots up to the canopy radius outside this chunk, then clip writes. */
export function placeTrees(chunk: Chunk, seed: number, terrain: TreeTerrain): void {
  const originX = chunk.x * 16, originZ = chunk.z * 16;
  const write = (wx: number, y: number, wz: number, id: number, metadata = 0): void => {
    const x = wx - originX, z = wz - originZ;
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y > 255) return;
    const previous = chunk.getBlockId(x, y, z);
    if (previous === Block.Air || previous === Block.Leaves || (previous === Block.Snow && id === Block.Log)) {
      chunk.setBlock(x, y, z, id, metadata);
    }
  };
  for (let z = originZ - 2; z <= originZ + 17; z++) {
    for (let x = originX - 2; x <= originX + 17; x++) {
      const hash = hash2(seed ^ 0x4c712, x, z) >>> 0;
      // Most columns are not roots; skip expensive terrain sampling early.
      if ((hash % 53 !== 0 && hash % 67 !== 0) || Math.hypot(x, z) < 20) continue;
      const biome = terrain.biomeAt(x, z);
      const spruce = biome === Biome.Snow && hash % 67 === 0;
      const oakOrBirch = hash % 53 === 0 && (biome === Biome.Forest || (biome === Biome.Plains && hash % 7 === 0));
      if (!spruce && !oakOrBirch) continue;
      const ground = terrain.heightAt(x, z);
      if (ground <= 63) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => Math.abs(terrain.heightAt(x + dx, z + dz) - ground) > 1)) continue;
      const metadata = spruce ? 1 : biome === Biome.Forest && (hash >>> 16) % 5 === 0 ? 2 : 0;
      const top = ground + (spruce ? 6 : metadata === 2 ? 5 : 4) + ((hash >>> 8) % 3);
      for (let y = ground + 1; y <= top; y++) write(x, y, z, Block.Log, metadata);
      if (spruce) {
        for (let y = top - 5; y <= top + 1; y++) {
          const radius = Math.min(2, Math.floor((top + 2 - y) / 2));
          for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
            if (radius === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            write(x + dx, y, z + dz, Block.Leaves, 1);
          }
        }
        continue;
      }
      for (let y = top - 2; y <= top + 1; y++) {
        const radius = y >= top ? 1 : 2;
        for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) === radius && Math.abs(dz) === radius && (y === top + 1 || ((hash >>> ((dx + dz + 8) & 15)) & 1))) continue;
          write(x + dx, y, z + dz, Block.Leaves, metadata);
        }
      }
    }
  }
}
