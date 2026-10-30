import fs from "node:fs";
import path from "node:path";
import { migrateFancyNpcs } from "../src/migrate/fancynpcs";
import { fetchMigrationSkins } from "../src/migrate/skins";
import { writeFileAtomic } from "../src/util/atomicWrite";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let input: string | undefined;
  let output = "plugins-data/npcs.json";
  let fetchSkins = false;
  let outputSeen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--fetch-skins" && !fetchSkins) fetchSkins = true;
    else if (arg === "--out" && !outputSeen && args[index + 1] && !args[index + 1].startsWith("--")) {
      output = args[++index];
      outputSeen = true;
    } else if (!arg.startsWith("--") && input === undefined) input = arg;
    else
      throw Error(
        "Usage: npx tsx scripts/migrate-fancynpcs.ts <path-to-npcs.yml> [--out plugins-data/npcs.json] [--fetch-skins]",
      );
  }
  if (!input) throw Error("Provide the path to npcs.yml");
  const source = path.resolve(input);
  const out = path.resolve(output);
  if (source === out) throw Error("Input and output must differ");
  if (fs.existsSync(out))
    throw Error("Output already exists; choose a new --out path and compare before replacing it");
  if (fs.statSync(source).size > 4 * 1024 * 1024) throw Error("YAML file exceeds 4 MiB");
  const { data, report } = migrateFancyNpcs(fs.readFileSync(source, "utf8"));
  const skinReport = fetchSkins ? await fetchMigrationSkins(data) : [];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeFileAtomic(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`Migrated ${report.migrated}; skipped ${report.skipped.length}.`);
  for (const line of report.skipped) console.log(`SKIPPED: ${line}`);
  for (const line of report.unsupported) console.log(`UNSUPPORTED: ${line}`);
  for (const line of report.warnings) {
    const refreshed =
      line.includes("needs refresh") &&
      data.npcs.some((npc) => npc.skin && line.startsWith(`${npc.id}: skin `));
    if (!refreshed) console.log(`NOTE: ${line}`);
  }
  for (const line of skinReport) console.log(`SKIN: ${line}`);
  console.log(`Wrote ${output}. Review leftovers/unsupported actions before starting the NPC plugin.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
