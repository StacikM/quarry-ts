/**
 * Writes src/protocol/vanillaTags.ts: the standard tags ("all the swords", "things that climb"...)
 * as lists of numbers, for the Update Tags packet.
 *
 * Why: the 1.21.11 client's own data refers to tags (an enchantment says which items it fits by
 * naming a tag). The client refuses to join unless the server has defined every tag, so we send them all.
 *
 * Where the data comes from: the tag files inside a Minecraft 1.21.11 client jar (data/minecraft/tags).
 * They are read, never copied: only tag names and the registry numbers of their members are written out.
 * Numbers for blocks, items and entity types come from minecraft-data; for the registries the server
 * sends itself (damage types, enchantments, biomes...) they are the positions in registryKeys.ts.
 *
 * Run once:  npx tsx scripts/generate-vanilla-tags.ts "path/to/1.21.11.jar"
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import minecraftData from "minecraft-data";
import { REGISTRY_KEYS } from "../src/protocol/registryKeys";

const jarPath = process.argv[2];
if (!jarPath) throw new Error("Usage: npx tsx scripts/generate-vanilla-tags.ts <path to 1.21.11.jar>");

/** Reads the files under data/minecraft/tags/ out of the jar (a zip file) without any dependency. */
function readTagFiles(jar: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  // The central directory at the end of the zip lists every file.
  let end = jar.length - 22;
  while (end >= 0 && jar.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  const count = jar.readUInt16LE(end + 10);
  let at = jar.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (jar.readUInt32LE(at) !== 0x02014b50) throw new Error("Damaged zip directory");
    const method = jar.readUInt16LE(at + 10);
    const compressedSize = jar.readUInt32LE(at + 20);
    const nameLength = jar.readUInt16LE(at + 28);
    const extraLength = jar.readUInt16LE(at + 30);
    const commentLength = jar.readUInt16LE(at + 32);
    const localAt = jar.readUInt32LE(at + 42);
    const name = jar.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!name.startsWith("data/minecraft/tags/") || !name.endsWith(".json")) continue;

    const dataAt = localAt + 30 + jar.readUInt16LE(localAt + 26) + jar.readUInt16LE(localAt + 28);
    const raw = jar.subarray(dataAt, dataAt + compressedSize);
    const text = method === 0 ? raw : zlib.inflateRawSync(raw);
    files.set(name.slice("data/minecraft/tags/".length, -".json".length), text.toString("utf8"));
  }
  return files;
}

const data = minecraftData("1.21.11");
/** Registry name -> (entry name -> number), for the registries whose numbers the game fixes. */
const staticIds: Record<string, Map<string, number>> = {
  "minecraft:block": new Map(data.blocksArray.map((block) => [block.name, block.id])),
  "minecraft:item": new Map(data.itemsArray.map((item) => [item.name, item.id])),
  "minecraft:entity_type": new Map(data.entitiesArray.map((entity) => [entity.name, entity.id])),
  "minecraft:fluid": new Map([["empty", 0], ["flowing_water", 1], ["water", 2], ["flowing_lava", 3], ["lava", 4]]),
};
const dynamic = (registry: string): Map<string, number> =>
  new Map(REGISTRY_KEYS[registry].map((key, id) => [key.replace(/^minecraft:/, ""), id]));

// Folder name in the jar -> registry. Folders not listed here are not sent to clients.
const registryOf: Record<string, string> = {
  block: "minecraft:block", item: "minecraft:item", entity_type: "minecraft:entity_type", fluid: "minecraft:fluid",
  banner_pattern: "minecraft:banner_pattern", damage_type: "minecraft:damage_type", dialog: "minecraft:dialog",
  enchantment: "minecraft:enchantment", instrument: "minecraft:instrument", painting_variant: "minecraft:painting_variant",
  timeline: "minecraft:timeline", "worldgen/biome": "minecraft:worldgen/biome",
};

const files = readTagFiles(fs.readFileSync(jarPath));
const result: Record<string, Record<string, number[]>> = {};

for (const [folder, registry] of Object.entries(registryOf)) {
  const ids = staticIds[registry] ?? dynamic(registry);
  const definitions = new Map<string, string[]>();
  for (const [file, text] of files) {
    if (!file.startsWith(`${folder}/`)) continue;
    const values = (JSON.parse(text) as { values: Array<string | { id: string }> }).values;
    definitions.set(file.slice(folder.length + 1), values.map((value) => (typeof value === "string" ? value : value.id)));
  }

  /** All members of a tag, with references to other tags (#minecraft:...) expanded. */
  const members = (tag: string, trail: string[] = []): Set<number> => {
    if (trail.includes(tag)) throw new Error(`Tag ${tag} refers to itself`);
    const found = new Set<number>();
    const entries = definitions.get(tag);
    if (!entries) throw new Error(`${registry}: tag ${tag} is used but not defined`);
    for (const entry of entries) {
      const name = entry.replace(/^#?minecraft:/, "");
      if (entry.startsWith("#")) {
        for (const id of members(name, [...trail, tag])) found.add(id);
      } else {
        const id = ids.get(name);
        if (id === undefined) throw new Error(`${registry}: tag ${tag} lists ${entry}, which does not exist`);
        found.add(id);
      }
    }
    return found;
  };

  result[registry] = {};
  for (const tag of [...definitions.keys()].sort()) {
    result[registry][`minecraft:${tag}`] = [...members(tag)].sort((a, b) => a - b);
  }
}

const lines = [
  "// GENERATED by scripts/generate-vanilla-tags.ts (Minecraft 1.21.11 tag lists). Do not edit by hand.",
  "",
  "/** Registry -> tag name -> numbers of the entries in the tag. */",
  "export const VANILLA_TAGS: Record<string, Record<string, readonly number[]>> = {",
];
for (const [registry, tags] of Object.entries(result)) {
  lines.push(`  ${JSON.stringify(registry)}: {`);
  for (const [tag, members] of Object.entries(tags)) lines.push(`    ${JSON.stringify(tag)}: ${JSON.stringify(members)},`);
  lines.push("  },");
}
lines.push("};", "");
fs.writeFileSync(path.join(__dirname, "..", "src", "protocol", "vanillaTags.ts"), lines.join("\n"));
console.log(Object.entries(result).map(([registry, tags]) => `${registry}: ${Object.keys(tags).length} tags`).join("\n"));
