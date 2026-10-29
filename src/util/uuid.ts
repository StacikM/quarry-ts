import { createHash } from "node:crypto";

/**
 * Builds the UUID a player gets on an "offline mode" server.
 *
 * Vanilla does this in Java with: UUID.nameUUIDFromBytes("OfflinePlayer:" + name)
 * That's a "version 3" UUID: an MD5 hash with a few bits overwritten.
 * Using the same formula means the UUIDs match what a vanilla server would give.
 */
export function offlineUUID(username: string): string {
  const hash = createHash("md5").update(`OfflinePlayer:${username}`, "utf8").digest();

  hash[6] = (hash[6] & 0x0f) | 0x30; // set version to 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // set the IETF variant

  const hex = hash.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
