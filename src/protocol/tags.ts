import { VANILLA_TAGS } from "./vanillaTags";

/**
 * Tags are named groups ("all the swords", "enchantments that cannot be combined").
 * The 1.21.11 client refuses to finish loading unless every tag that the standard
 * game data refers to has been defined by the server, so we send the standard ones.
 * The lists are generated from the game's own tag files: see scripts/generate-vanilla-tags.ts.
 */
export interface RegistryTags {
  registry: string;
  tags: Array<{ name: string; entries: readonly number[] }>;
}

export function allTags(): RegistryTags[] {
  return Object.entries(VANILLA_TAGS).map(([registry, tags]) => ({
    registry,
    tags: Object.entries(tags).map(([name, entries]) => ({ name, entries })),
  }));
}
