import fs from "node:fs";

/**
 * Replaces `file` with `data` so that it is never left half-written.
 *
 * 1. Write everything to "<file>.tmp" and force it onto the disk (fsync).
 * 2. Rename the temp file over the real one. Renaming is atomic, so anyone
 *    reading the file sees either the complete old contents or the complete new ones.
 *
 * A crash at any point leaves the previous file intact (plus maybe a stray .tmp,
 * which is ignored). The fsync also covers a power cut, as far as the
 * operating system and disk honour it; we do not fsync the folder itself.
 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const tempFile = `${file}.tmp`;
  const fd = fs.openSync(tempFile, "w");
  try {
    // writeSync may write less than we asked for and returns how much it did write.
    for (let written = 0; written < bytes.length; ) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempFile, file);
}
