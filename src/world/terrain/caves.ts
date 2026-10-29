import { PerlinNoise } from "./noise";

/** Intersections of two noise surfaces form winding underground tunnels. */
export class CaveSampler {
  private readonly first: PerlinNoise;
  private readonly second: PerlinNoise;

  constructor(seed: number) {
    this.first = new PerlinNoise(seed ^ 0x64f3a);
    this.second = new PerlinNoise(seed ^ 0x19c83);
  }

  isCave(x: number, y: number, z: number, surface: number): boolean {
    // Leave four solid blocks under every surface, including the sea floor.
    if (y < 5 || y > surface - 5) return false;
    return Math.abs(this.first.noise3((x + 113) / 30, (y + 71) / 24, (z - 313) / 30)) < 0.065
      && Math.abs(this.second.noise3((x - 513) / 34, (y - 59) / 28, (z + 197) / 34)) < 0.065;
  }
}
