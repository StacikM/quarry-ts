import type { TerrainGenerator } from "../TerrainGenerator";
import { NaturalGenerator } from "./NaturalGenerator";

export function createNaturalGenerator(seed: number): TerrainGenerator {
  return new NaturalGenerator(seed);
}
