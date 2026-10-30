import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Chunk } from "../Chunk";
import type { TerrainGenerator } from "../TerrainGenerator";
import { biomeId } from "../biomeIds";
import { stateOf } from "../blockStates";
import { logger } from "../../util/logger";
import { readNbt, type NbtData } from "./nbtReader";

type Compound = { [key: string]: NbtData };

/** A chunk file entry bigger than this is not a real chunk. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Where the 1.18+ chunk format starts (DataVersion 2825 is 1.18). Older worlds are laid out differently. */
const FIRST_SUPPORTED_DATA_VERSION = 2825;
/** After this many problems, further ones are counted but not printed. */
const MAX_LOGGED_PROBLEMS = 8;

const AIR = stateOf("air");
const PLAINS = biomeId("plains");

/**
 * Shows an existing Minecraft world as this server's map. It reads the world's
 * region files (the `region` folder of a 1.18 or newer world, as made by vanilla,
 * Paper, Spigot...) and hands the blocks of the part between y=0 and y=255 to the
 * server. Blocks above and below that, block entities (chests, signs...) and
 * entities are not loaded. The map folder is only read, never changed: edits made
 * by players are saved in this server's own world folder.
 *
 * Chunks that the map does not have are empty, so a lobby floats in the void.
 */
export class AnvilGenerator implements TerrainGenerator {
  readonly name: string;

  private readonly regions = new Map<string, Region | null>();
  private readonly unknownBlocks = new Set<string>();
  private problems = 0;
  /** How many chunks had blocks above y=255 or below y=0 that could not be used. */
  outOfRangeChunks = 0;

  constructor(private readonly folder: string) {
    if (!fs.existsSync(path.join(folder, "region"))) throw new Error(`There is no "region" folder in ${folder}`);
    // Each map gets its own folder for the changes players make to it.
    this.name = `map-${path.basename(path.resolve(folder)).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  }

  generate(chunk: Chunk): void {
    let root: Compound | null;
    try {
      root = this.readChunk(chunk.x, chunk.z);
    } catch (err) {
      this.problem(`Cannot read chunk ${chunk.x},${chunk.z} of the map: ${(err as Error).message}`);
      return;
    }
    if (!root) return;

    const version = root.DataVersion;
    if (typeof version !== "number" || version < FIRST_SUPPORTED_DATA_VERSION || !Array.isArray(root.sections)) {
      this.problem(`Chunk ${chunk.x},${chunk.z} is from a world older than Minecraft 1.18; open the world in 1.21 once to upgrade it`);
      return;
    }

    let outOfRange = false;
    for (const section of root.sections as Compound[]) {
      const y = section.Y;
      if (typeof y !== "number") continue;
      const blockStates = section.block_states as Compound | undefined;
      if (!blockStates) continue;

      if (y < 0 || y > 15) {
        if (!isOnlyAir(blockStates)) outOfRange = true;
        continue;
      }
      const states = this.readStates(blockStates);
      if (!states) continue;
      for (let i = 0; i < 4096; i++) {
        if (states[i] !== AIR) chunk.setBlock(i & 15, y * 16 + (i >> 8), (i >> 4) & 15, states[i]);
      }
    }
    if (outOfRange) this.outOfRangeChunks++;
    this.readBiomes(chunk, root.sections as Compound[]);
  }

  /** The 4096 block states of a section, or null if it is unusable. Index: (y << 8) | (z << 4) | x. */
  private readStates(blockStates: Compound): Uint16Array | null {
    const palette = blockStates.palette;
    if (!Array.isArray(palette) || palette.length === 0) return null;
    const stateIds = (palette as Compound[]).map((entry) => this.stateFor(entry));

    const states = new Uint16Array(4096);
    if (palette.length === 1) return states.fill(stateIds[0]);

    const data = blockStates.data;
    if (!(data instanceof BigInt64Array)) return null;
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const perLong = Math.floor(64 / bits);
    if (data.length < Math.ceil(4096 / perLong)) return null;
    const mask = (1n << BigInt(bits)) - 1n;
    for (let i = 0; i < 4096; i++) {
      const long = BigInt.asUintN(64, data[Math.floor(i / perLong)]);
      const index = Number((long >> BigInt((i % perLong) * bits)) & mask);
      states[i] = stateIds[index] ?? AIR;
    }
    return states;
  }

  /** The block state a palette entry stands for; blocks this version does not know become air. */
  private stateFor(entry: Compound): number {
    const name = typeof entry.Name === "string" ? entry.Name : "air";
    const properties: Record<string, string> = {};
    if (entry.Properties && typeof entry.Properties === "object") {
      for (const [key, value] of Object.entries(entry.Properties as Compound)) properties[key] = String(value);
    }
    try {
      return stateOf(name, properties);
    } catch {
      try {
        return stateOf(name); // the block exists but a property does not: use its default look
      } catch {
        if (!this.unknownBlocks.has(name)) {
          this.unknownBlocks.add(name);
          this.problem(`The map has a block this server does not know: ${name} (it becomes air)`);
        }
        return AIR;
      }
    }
  }

  /** Biomes are stored in 4x4x4 cells; each column takes the cell from the section around y=64. */
  private readBiomes(chunk: Chunk, sections: Compound[]): void {
    const section = sections.find((candidate) => candidate.Y === 4) ?? sections.find((candidate) => candidate.biomes);
    const biomes = section?.biomes as Compound | undefined;
    const palette = biomes?.palette;
    if (!biomes || !Array.isArray(palette) || palette.length === 0) return;

    const ids = (palette as string[]).map((name) => {
      try {
        return biomeId(String(name));
      } catch {
        return PLAINS;
      }
    });
    const data = biomes.data;
    const bits = Math.max(1, Math.ceil(Math.log2(palette.length)));
    const perLong = Math.floor(64 / bits);
    const cell = (index: number): number => {
      if (palette.length === 1 || !(data instanceof BigInt64Array)) return ids[0];
      const long = BigInt.asUintN(64, data[Math.floor(index / perLong)] ?? 0n);
      return ids[Number((long >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n))] ?? PLAINS;
    };
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) chunk.setBiome(x, z, cell((1 << 4) | ((z >> 2) << 2) | (x >> 2)));
    }
  }

  /** The chunk's NBT from its region file, or null if the map has no such chunk. */
  private readChunk(chunkX: number, chunkZ: number): Compound | null {
    const region = this.region(chunkX >> 5, chunkZ >> 5);
    if (!region) return null;

    const slot = (chunkX & 31) + (chunkZ & 31) * 32;
    const location = region.header.readUInt32BE(slot * 4);
    const sector = location >>> 8;
    const sectors = location & 0xff;
    if (sector === 0 || sectors === 0) return null;

    const start = sector * 4096;
    const head = Buffer.alloc(5);
    if (fs.readSync(region.fd, head, 0, 5, start) < 5) throw new Error("the region file ends early");
    const length = head.readUInt32BE(0); // counts the compression byte
    const compression = head[4];
    if (length < 2 || length - 1 > MAX_CHUNK_BYTES || length > sectors * 4096) throw new Error(`bad chunk length ${length}`);

    const payload = Buffer.alloc(length - 1);
    if (fs.readSync(region.fd, payload, 0, payload.length, start + 5) < payload.length) throw new Error("the region file ends early");

    let nbt: Buffer;
    switch (compression) {
      case 1:
        nbt = zlib.gunzipSync(payload, { maxOutputLength: MAX_CHUNK_BYTES * 4 });
        break;
      case 2:
        nbt = zlib.inflateSync(payload, { maxOutputLength: MAX_CHUNK_BYTES * 4 });
        break;
      case 3:
        nbt = payload;
        break;
      default:
        throw new Error(`unsupported compression type ${compression} (set region-file-compression=deflate in the world's server and resave it)`);
    }
    return readNbt(nbt);
  }

  private region(regionX: number, regionZ: number): Region | null {
    const key = `${regionX},${regionZ}`;
    if (this.regions.has(key)) return this.regions.get(key) ?? null;

    let region: Region | null = null;
    const file = path.join(this.folder, "region", `r.${regionX}.${regionZ}.mca`);
    try {
      const fd = fs.openSync(file, "r");
      const header = Buffer.alloc(4096);
      if (fs.readSync(fd, header, 0, 4096, 0) < 4096) {
        fs.closeSync(fd);
        throw new Error("the region file has no header");
      }
      region = { fd, header };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.problem(`Cannot open ${file}: ${(err as Error).message}`);
    }
    this.regions.set(key, region);
    return region;
  }

  /** Closes the map files. */
  close(): void {
    for (const region of this.regions.values()) if (region) fs.closeSync(region.fd);
    this.regions.clear();
  }

  private problem(message: string): void {
    this.problems++;
    if (this.problems <= MAX_LOGGED_PROBLEMS) logger.warn(message);
    else if (this.problems === MAX_LOGGED_PROBLEMS + 1) logger.warn("More problems with the map follow; they are not printed.");
  }
}

interface Region {
  fd: number;
  header: Buffer;
}

function isOnlyAir(blockStates: Compound): boolean {
  const palette = blockStates.palette;
  if (!Array.isArray(palette)) return true;
  return (palette as Compound[]).every((entry) => typeof entry.Name === "string" && /^minecraft:(cave_|void_)?air$/.test(entry.Name));
}

/**
 * Where the world's own spawn point is, from level.dat (its x, y and z), or null when it has none.
 * Worlds saved by 1.21.9 and newer keep it in a "spawn" entry; older ones in SpawnX/SpawnY/SpawnZ.
 */
export function readMapSpawn(folder: string): { x: number; y: number; z: number } | null {
  try {
    const data = (readNbt(zlib.gunzipSync(fs.readFileSync(path.join(folder, "level.dat")))).Data ?? {}) as Compound;
    const spawn = data.spawn as Compound | undefined;
    if (spawn && Array.isArray(spawn.pos) && spawn.pos.length === 3) {
      const [x, y, z] = spawn.pos as number[];
      return { x, y, z };
    }
    if (typeof data.SpawnX === "number" && typeof data.SpawnY === "number" && typeof data.SpawnZ === "number") {
      return { x: data.SpawnX, y: data.SpawnY, z: data.SpawnZ };
    }
  } catch {
    // no level.dat, or one we cannot read: the caller uses the configured spawn
  }
  return null;
}
