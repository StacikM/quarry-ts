import { REGISTRY_KEYS } from "../protocol/registryKeys";

const BIOMES = REGISTRY_KEYS["minecraft:worldgen/biome"];

/** How many biomes the client knows. */
export const BIOME_COUNT = BIOMES.length;

/**
 * The number the protocol uses for a biome ("plains", "minecraft:desert"...).
 * It is the biome's position in the list the server sends during login, so
 * the same list (registryKeys.ts) is used for both.
 */
export function biomeId(name: string): number {
  const full = name.includes(":") ? name : `minecraft:${name}`;
  const id = BIOMES.indexOf(full);
  if (id < 0) throw new RangeError(`Unknown biome: ${name}`);
  return id;
}
