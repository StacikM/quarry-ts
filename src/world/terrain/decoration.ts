import { Block } from "../blocks";
import type { Chunk } from "../Chunk";
import { Biome } from "./biomes";
import type { TreeTerrain } from "./trees";
import { hash2 } from "./random";

const CARDINAL = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const cactusHash = (seed: number, x: number, z: number): number => hash2(seed ^ 0x6ca17, x, z) >>> 0;

/** Single-column decorations depend only on world coordinates and base terrain. */
export function decorate(chunk: Chunk, seed: number, terrain: TreeTerrain): void {
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const wx = chunk.x * 16 + x, wz = chunk.z * 16 + z;
    if (Math.abs(wx) <= 1 && Math.abs(wz) <= 1) continue;
    const hash = hash2(seed ^ 0x4deca, wx, wz) >>> 0;
    const height = terrain.heightAt(wx, wz), y = height + 1;
    if (chunk.getState(x, y, z) !== Block.Air) continue;
    const surface = chunk.getState(x, height, z);
    const biome = chunk.getBiome(x, z);
    // Water must be adjacent at the supporting block's elevation.
    if (height === 62 && (surface === Block.Sand || surface === Block.Grass) && hash % 5 === 0
      && CARDINAL.some(([dx, dz]) => terrain.heightAt(wx + dx, wz + dz) < 62)) {
      const tall = 2 + ((hash >>> 8) & 1);
      for (let dy = 0; dy < tall; dy++) chunk.setBlock(x, y + dy, z, Block.SugarCane);
    } else if (biome === Biome.Desert && surface === Block.Sand) {
      const rootHash = cactusHash(seed, wx, wz);
      let cactus = rootHash % 79 === 0 && height > 63;
      if (cactus) {
        // No neighboring cactus roots; neighboring terrain must be below the stalk.
        cactus = CARDINAL.every(([dx, dz]) => terrain.heightAt(wx + dx, wz + dz) <= height
          && cactusHash(seed, wx + dx, wz + dz) % 79 !== 0);
      }
      if (cactus) {
        // Keep canopies from neighboring biomes away from every cactus block.
        for (let dz = -2; dz <= 2 && cactus; dz++) for (let dx = -2; dx <= 2; dx++) {
          if (terrain.biomeAt(wx + dx, wz + dz) !== Biome.Desert) { cactus = false; break; }
        }
      }
      if (cactus) {
        const tall = 1 + ((rootHash >>> 8) % 3);
        for (let dy = 0; dy < tall; dy++) chunk.setBlock(x, y + dy, z, Block.Cactus);
      } else if (hash % 47 === 0) chunk.setBlock(x, y, z, Block.DeadBush);
    } else if (surface === Block.Grass && (biome === Biome.Plains || biome === Biome.Forest)) {
      if (hash % 89 === 0) chunk.setBlock(x, y, z, Block.Dandelion);
      else if (hash % 97 === 0) chunk.setBlock(x, y, z, Block.Poppy);
      else if (hash % (biome === Biome.Plains ? 7 : 12) === 0) chunk.setBlock(x, y, z, Block.TallGrass);
    }
  }
}
