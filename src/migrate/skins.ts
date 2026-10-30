import type { NpcDocument } from "../plugins/builtin/npcData";
import type { SkinData } from "../plugins/types";

export interface SkinFetchOptions {
  fetch?: typeof fetch;
  pause?: (milliseconds: number) => Promise<void>;
}

/** Migration-only network helper. The server never calls this or looks up skins. */
export async function fetchMigrationSkins(
  document: NpcDocument,
  options: SkinFetchOptions = {},
): Promise<string[]> {
  const request = options.fetch ?? fetch;
  const pause =
    options.pause ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const cache = new Map<string, SkinData | null>();
  const report: string[] = [];
  let first = true;

  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await request(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    if (!response.body) throw Error("Empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 128 * 1024) {
        await reader.cancel();
        throw Error("Response exceeds 128 KiB");
      }
      chunks.push(next.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Invalid API object");
    return parsed as Record<string, unknown>;
  };

  for (const npc of document.npcs) {
    if (npc.skin || !npc.skinName) continue;
    const identifier = npc.skinName.trim();
    const key = identifier.toLowerCase();
    if (!cache.has(key)) {
      if (!first) await pause(300);
      first = false;
      let skin: SkinData | null = null;
      try {
        let uuid: string;
        if (/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(identifier))
          uuid = identifier.replace(/-/g, "");
        else {
          if (!/^[a-z0-9_]{1,16}$/i.test(identifier))
            throw Error("Identifier is not a player name or UUID; no request sent");
          const profile = await getJson(
            `https://api.mojang.com/minecraft/profile/lookup/name/${encodeURIComponent(identifier)}`,
          );
          if (typeof profile.id !== "string" || !/^[0-9a-f]{32}$/i.test(profile.id))
            throw Error("Name lookup returned no valid UUID");
          uuid = profile.id;
        }
        const profile = await getJson(
          `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}?unsigned=false`,
        );
        const texture = Array.isArray(profile.properties)
          ? profile.properties.find(
              (property) => property && typeof property === "object" && property.name === "textures",
            )
          : undefined;
        if (
          !texture ||
          typeof texture.value !== "string" ||
          !texture.value ||
          texture.value.length > 32767 ||
          typeof texture.signature !== "string" ||
          !texture.signature ||
          texture.signature.length > 1024
        )
          throw Error("Profile has no valid signed texture");
        skin = { value: texture.value, signature: texture.signature };
      } catch (error) {
        report.push(
          `Skin lookup failed for ${identifier}: ${error instanceof Error ? error.message : String(error)}; skinName retained.`,
        );
      }
      cache.set(key, skin);
    }
    const skin = cache.get(key);
    if (skin) {
      npc.skin = { ...skin };
      report.push(`${npc.id}: fetched signed skin for ${identifier}.`);
    }
  }
  return report;
}
