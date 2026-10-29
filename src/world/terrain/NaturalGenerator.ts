import { Block } from "../blocks";
import type { Chunk } from "../Chunk";
import type { TerrainGenerator } from "../TerrainGenerator";
import { fractal2, PerlinNoise } from "./noise";
import { hash2 } from "./random";
import { Biome, BiomeSampler } from "./biomes";
import { CaveSampler } from "./caves";
import { placeOres } from "./ores";
import { placeTrees } from "./trees";
import { decorate } from "./decoration";

export class NaturalGenerator implements TerrainGenerator {
  readonly name = "natural";
  private readonly elevation: PerlinNoise;
  private readonly biomes: BiomeSampler;
  private readonly caves: CaveSampler;

  constructor(private readonly seed: number) {
    this.elevation = new PerlinNoise(seed);
    this.biomes = new BiomeSampler(seed);
    this.caves = new CaveSampler(seed);
  }

  /** Sampling world coordinates makes adjacent chunks share one heightmap. */
  heightAt(x: number, z: number): number {
    const broad = fractal2(this.elevation, (x + 1937) / 192, (z - 7919) / 192, 4);
    const detail = this.elevation.noise2((x - 101) / 32, (z + 307) / 32);
    const relief = broad * 65 + detail * 4;
    // Asymmetric smooth saturation keeps deep water and peaks without plateaus.
    const range = relief < 0 ? 22 : 38;
    const natural = 72 + range * Math.tanh(relief / range);
    // Keep the initial spawn on land for every seed, with a smooth transition.
    const t = Math.max(0, Math.min(1, (Math.hypot(x, z) - 16) / 48));
    const blend = t * t * (3 - 2 * t);
    return Math.floor(72 + (natural - 72) * blend);
  }

  biomeAt(x: number, z: number, height = this.heightAt(x, z)): number {
    if (height >= 60 && height <= 63) {
      // Restrict beaches to columns close to an actual body of water.
      for (const [dx, dz] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
        if (this.heightAt(x + dx, z + dz) < 62) return Biome.Beach;
      }
    }
    return this.biomes.at(x, z, height);
  }

  generate(chunk: Chunk): void {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const worldX = chunk.x * 16 + x;
        const worldZ = chunk.z * 16 + z;
        const height = this.heightAt(worldX, worldZ);
        const biome = this.biomeAt(worldX, worldZ, height);
        chunk.setBiome(x, z, biome);
        const bedrock = hash2(this.seed, worldX, worldZ) >>> 0;
        let surface: number = Block.Grass;
        let soil: number = Block.Dirt;
        if (biome === Biome.Desert) surface = soil = Block.Sand;
        else if (biome === Biome.Beach || biome === Biome.Ocean) {
          const material = bedrock % 5;
          surface = soil = material === 0 ? Block.Gravel : material === 1 && biome === Biome.Ocean ? Block.Dirt : Block.Sand;
        } else if (biome === Biome.Mountains && height > 94) surface = soil = Block.Stone;
        for (let y = 0; y <= height; y++) {
          let block: number = Block.Stone;
          if (y === 0 || (y < 5 && ((bedrock >>> (y * 4)) & 15) < (5 - y) * 3)) {
            block = Block.Bedrock;
          } else if (y === height) {
            block = surface;
          } else if (y >= height - 3) {
            block = soil;
          } else if (this.caves.isCave(worldX, y, worldZ, height)) {
            block = y < 10 ? Block.Lava : Block.Air;
          }
          chunk.setBlock(x, y, z, block);
        }
        for (let y = height + 1; y <= 62; y++) chunk.setBlock(x, y, z, Block.Water);
        if ((Math.abs(worldX) > 1 || Math.abs(worldZ) > 1)
          && (biome === Biome.Snow || (biome === Biome.Mountains && height > 100))) {
          chunk.setBlock(x, height + 1, z, Block.Snow);
        }
      }
    }
    placeOres(chunk, this.seed);
    placeTrees(chunk, this.seed, this);
    decorate(chunk, this.seed, this);
  }
}
