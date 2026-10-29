import { PerlinNoise } from "./noise";

export const Biome = { Ocean: 0, Plains: 1, Desert: 2, Mountains: 3, Forest: 4, Snow: 12, Beach: 16 } as const;

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
