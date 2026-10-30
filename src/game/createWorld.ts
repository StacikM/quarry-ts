import path from "node:path";
import { World } from "../world/World";
import { WorldStorage } from "../world/WorldStorage";
import { FlatGenerator } from "../world/FlatGenerator";
import { VoidGenerator } from "../world/VoidGenerator";
import { AnvilGenerator, readMapSpawn } from "../world/anvil/AnvilGenerator";
import type { TerrainGenerator } from "../world/TerrainGenerator";
import { config } from "../config";
import { logger } from "../util/logger";

/**
 * Builds the world with the generator chosen in config.ts.
 *
 * The natural generator lives in world/terrain/ and is loaded lazily so the
 * server still starts (with a flat world) if that folder is missing or broken.
 */
export function createWorld(): World {
  const generator = pickGenerator();
  // Edits only make sense for the terrain they were made on, so each
  // generator + seed combination gets its own folder.
  const folder = path.resolve("world", "1.21.11", `${generator.name}-${config.seed}`);
  logger.info(`World saves: ${folder}`);
  return new World(generator, new WorldStorage(folder));
}

function pickGenerator(): TerrainGenerator {
  if (config.mapFolder) {
    const folder = path.resolve(config.mapFolder);
    // A map that cannot be opened stops the server: silently showing a different world would be worse.
    const generator = new AnvilGenerator(folder);
    logger.info(`World generator: the map in ${folder}`);
    const spawn = config.useMapSpawn ? readMapSpawn(folder) : null;
    if (spawn) {
      config.spawn = { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 };
      logger.info(`Spawn point from the map: ${spawn.x}, ${spawn.y}, ${spawn.z}`);
    }
    return generator;
  }
  if (config.generator === "void") {
    logger.info("World generator: void (a small platform at the spawn)");
    return new VoidGenerator();
  }
  if (config.generator === "natural") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createNaturalGenerator } = require("../world/terrain/index");
      const generator: TerrainGenerator = createNaturalGenerator(config.seed);
      logger.info(`World generator: ${generator.name} (seed ${config.seed})`);
      return generator;
    } catch (err) {
      logger.warn(`Natural terrain unavailable, using flat world: ${(err as Error).message}`);
    }
  }
  logger.info("World generator: flat");
  return new FlatGenerator();
}
