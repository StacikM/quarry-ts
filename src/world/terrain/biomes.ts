import { PerlinNoise } from "./noise";
import { biomeId } from "../biomeIds";

export const Biome = {
  Ocean: biomeId('ocean'), Plains: biomeId('plains'), Desert: biomeId('desert'),
  Mountains: biomeId('windswept_hills'), Forest: biomeId('forest'),
  River: biomeId('river'), Snow: biomeId('snowy_plains'), Beach: biomeId('beach'),
} as const;

export class BiomeSampler {
  private readonly temperature: PerlinNoise;
  private readonly humidity: PerlinNoise;

  constructor(seed: number) {
    this.temperature = new PerlinNoise(seed ^ 0x31f12);
    this.humidity = new PerlinNoise(seed ^ 0x71e93);
  }

  at(x: number, z: number, height: number): number {
    if (height < 62) return Biome.Ocean;
    if (height >= 90) return Biome.Mountains;
    const temperature = this.temperature.noise2((x + 137) / 256, (z - 731) / 256);
    const humidity = this.humidity.noise2((x - 917) / 256, (z + 263) / 256);
    if (temperature < -0.12) return Biome.Snow;
    if (temperature > 0.12 && humidity < 0.02) return Biome.Desert;
    if (humidity > 0.04) return Biome.Forest;
    return Biome.Plains;
  }
}
