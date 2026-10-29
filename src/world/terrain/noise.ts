import { mulberry32 } from "./random";

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + t * (b - a);

/** Seeded 2D gradient noise, continuous across chunk boundaries. */
export class PerlinNoise {
  private readonly permutation = new Uint8Array(512);

  constructor(seed: number) {
    const random = mulberry32(seed);
    const values = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    for (let i = 0; i < 512; i++) this.permutation[i] = values[i & 255];
  }

  private gradient(hash: number, x: number, z: number): number {
    // Unit diagonal gradients keep the interpolated result within [-1, 1].
    return ((hash & 1 ? -x : x) + (hash & 2 ? -z : z)) * Math.SQRT1_2;
  }

  noise2(x: number, z: number): number {
    const floorX = Math.floor(x);
    const floorZ = Math.floor(z);
    const ix = floorX & 255;
    const iz = floorZ & 255;
    const dx = x - floorX;
    const dz = z - floorZ;
    const p = this.permutation;
    const a = p[ix] + iz;
    const b = p[ix + 1] + iz;
    const u = fade(dx);
    const v = fade(dz);
    return lerp(
      lerp(this.gradient(p[a], dx, dz), this.gradient(p[b], dx - 1, dz), u),
      lerp(this.gradient(p[a + 1], dx, dz - 1), this.gradient(p[b + 1], dx - 1, dz - 1), u),
      v,
    );
  }

  noise3(x: number, y: number, z: number): number {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const ix = fx & 255, iy = fy & 255, iz = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const p = this.permutation;
    const u = fade(x), v = fade(y), w = fade(z);
    const a = p[ix] + iy, b = p[ix + 1] + iy;
    const aa = p[a] + iz, ab = p[a + 1] + iz;
    const ba = p[b] + iz, bb = p[b + 1] + iz;
    const grad = (h: number, dx: number, dy: number, dz: number): number => {
      h &= 15;
      const first = h < 8 ? dx : dy;
      const second = h < 4 ? dy : h === 12 || h === 14 ? dx : dz;
      return ((h & 1 ? -first : first) + (h & 2 ? -second : second)) * Math.SQRT1_2;
    };
    return lerp(
      lerp(lerp(grad(p[aa], x, y, z), grad(p[ba], x - 1, y, z), u),
        lerp(grad(p[ab], x, y - 1, z), grad(p[bb], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(p[aa + 1], x, y, z - 1), grad(p[ba + 1], x - 1, y, z - 1), u),
        lerp(grad(p[ab + 1], x, y - 1, z - 1), grad(p[bb + 1], x - 1, y - 1, z - 1), u), v), w,
    );
  }
}

/** Amplitude-normalized octaves; zero octaves produce zero noise. */
export function fractal2(
  noise: { noise2(x: number, z: number): number },
  x: number,
  z: number,
  octaves = 4,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let sum = 0;
  let weight = 0;
  let amplitude = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise.noise2(x, z) * amplitude;
    weight += amplitude;
    amplitude *= persistence;
    x *= lacunarity;
    z *= lacunarity;
  }
  return weight === 0 ? 0 : sum / weight;
}
