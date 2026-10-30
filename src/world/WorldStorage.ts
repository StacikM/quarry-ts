import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { logger } from "../util/logger";
import { writeFileAtomic } from "../util/atomicWrite";
import { STATE_COUNT } from "./blockStates";

/**
 * Saves the blocks that players changed, one small file per chunk.
 *
 * We do NOT save whole chunks. The terrain generator can recreate untouched
 * terrain from the seed, so we only store the differences ("edits"):
 *   - files stay tiny (a chunk with a few placed blocks is a few dozen bytes)
 *   - when the terrain generator improves, old worlds pick it up automatically
 *     everywhere except at the exact blocks players changed
 *
 * File layout (all numbers little-endian), after the header the rest is deflated:
 *   "MCED" (4 bytes) | format version (1 byte) | deflate( count: u32, then count x [index: u16, state: u16] )
 * `index` is the block's position in the chunk and `state` is the block state number
 * Chunk uses internally (the one the Minecraft 1.21.11 protocol uses). deflate also gives us a checksum,
 * so a damaged file is detected instead of being loaded as garbage.
 */
const MAGIC = Buffer.from("MCED");
/** Version 2: states are 1.21.11 block state numbers. (Version 1 held 1.8 ids and is never read.) */
const FORMAT_VERSION = 2;
const BLOCKS_PER_CHUNK = 16 * 16 * 256;
/** The biggest valid payload: a count plus one 4-byte entry for every block in the chunk. */
const MAX_PAYLOAD_BYTES = 4 + BLOCKS_PER_CHUNK * 4;
/** A valid file can't be bigger than that payload compressed (deflate adds a little on incompressible data). */
const MAX_FILE_BYTES = MAX_PAYLOAD_BYTES + 1024;

export type ChunkEdits = Map<number, number>;

export class WorldStorage {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  private fileFor(chunkX: number, chunkZ: number): string {
    return path.join(this.directory, `${chunkX}.${chunkZ}.edits`);
  }

  /**
   * Returns the saved edits, or null if this chunk was never edited.
   *
   * Throws if the file exists but cannot be READ (disk error, permissions...).
   * That must not be treated as "no edits": the caller would generate a fresh
   * chunk and the next save would overwrite the player's real build.
   * A file that reads fine but has bad CONTENT is different: it is set aside
   * as .corrupt and the chunk is treated as unedited.
   */
  load(chunkX: number, chunkZ: number): ChunkEdits | null {
    const file = this.fileFor(chunkX, chunkZ);

    let bytes: Buffer;
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        return this.quarantine(file, chunkX, chunkZ, new Error(`file is ${size} bytes, larger than any valid save`));
      }
      bytes = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // never edited
      throw new Error(`Cannot read saved chunk ${chunkX},${chunkZ}: ${(err as Error).message}`);
    }

    try {
      return decodeEdits(bytes);
    } catch (err) {
      return this.quarantine(file, chunkX, chunkZ, err as Error);
    }
  }

  /** Sets a file with confirmed-bad contents aside (kept for inspection) and returns null. */
  private quarantine(file: string, chunkX: number, chunkZ: number, reason: Error): null {
    const quarantined = `${file}.corrupt`;
    try {
      fs.renameSync(file, quarantined);
    } catch {
      // If even renaming fails, we still carry on with an unedited chunk.
    }
    logger.error(`Saved chunk ${chunkX},${chunkZ} is damaged (${reason.message}); moved to ${quarantined}`);
    return null;
  }

  save(chunkX: number, chunkZ: number, edits: ChunkEdits): void {
    writeFileAtomic(this.fileFor(chunkX, chunkZ), encodeEdits(edits));
  }
}

export function encodeEdits(edits: ChunkEdits): Buffer {
  const payload = Buffer.alloc(4 + edits.size * 4);
  payload.writeUInt32LE(edits.size, 0);
  let offset = 4;
  for (const [index, state] of edits) {
    offset = payload.writeUInt16LE(index, offset);
    offset = payload.writeUInt16LE(state, offset);
  }
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), zlib.deflateSync(payload)]);
}

/** Throws a descriptive Error if the data is not a valid edits file. */
export function decodeEdits(file: Buffer): ChunkEdits {
  if (file.length < MAGIC.length + 1 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not an edits file");
  }
  const version = file[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported format version ${version}`);
  }

  // maxOutputLength stops a tiny crafted file from expanding into gigabytes before we validate it.
  const payload = zlib.inflateSync(file.subarray(MAGIC.length + 1), { maxOutputLength: MAX_PAYLOAD_BYTES }); // throws if damaged
  if (payload.length < 4) throw new Error("payload too short");

  const count = payload.readUInt32LE(0);
  if (count > BLOCKS_PER_CHUNK || payload.length !== 4 + count * 4) {
    throw new Error("entry count does not match payload size");
  }

  const edits: ChunkEdits = new Map();
  for (let i = 0, offset = 4; i < count; i++, offset += 4) {
    const index = payload.readUInt16LE(offset);
    const state = payload.readUInt16LE(offset + 2);
    // (A u16 index can't be out of range: 65535 is the last of the 65536 blocks.)
    if (state >= STATE_COUNT) throw new Error("block state out of range");
    edits.set(index, state);
  }
  return edits;
}
