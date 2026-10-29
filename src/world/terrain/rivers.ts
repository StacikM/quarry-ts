import { PerlinNoise } from "./noise";

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Connected noise contours produce channels without consulting neighboring chunks. */
export class RiverSampler {
  private readonly channel: PerlinNoise;
  private readonly depth: PerlinNoise;

  constructor(seed: number) {
    this.channel = new PerlinNoise(seed ^ 0x5a71f);
    this.depth = new PerlinNoise(seed ^ 0x8d391);
  }

  strengthAt(x: number, z: number): number {
    if (Math.hypot(x, z) <= 64) return 0;
    const ridge = Math.abs(this.channel.noise2((x + 431) / 384, (z - 173) / 384));
    const strength = 1 - smoothstep(0.012, 0.075, ridge);
    return strength * smoothstep(64, 128, Math.hypot(x, z));
  }

  carveHeight(x: number, z: number, base: number): number {
    const strength = this.strengthAt(x, z);
    if (strength === 0) return base;
    const bed = 58.5 + Math.max(-0.75, Math.min(0.75, this.depth.noise2((x - 719) / 128, (z + 283) / 128))) * 2;
    // Channels only lower terrain: crossing an existing ocean never raises its floor.
    return Math.min(base, Math.floor(base + (bed - base) * strength));
  }
}
