/**
 * Checks config.json: that the server creates it with every setting, adds the settings an update introduces without
 * touching the values you wrote, takes over an old server.json, reads the new settings (pvp, respawn), and that the
 * environment variables of a hosting panel still win when they are filled in.
 * Run with:  npx tsx scripts/config-file-check.ts
 *
 * Everything happens in temporary folders.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS, ensureSettingsFile } from "../src/settingsFile";

const root = path.resolve(__dirname, "..");
const tsxBin = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const url = (...parts: string[]): string => pathToFileURL(path.join(root, ...parts)).href;
const tempFolder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-config-"));
const read = (dir: string, name = "config.json"): any => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

/** Runs ensureSettingsFile and returns what the console said. */
function ensure(dir: string): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
  try {
    ensureSettingsFile(dir);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return lines;
}

/** The settings the server would run with in `dir`, loaded in a separate process like a real start. */
function loadConfig(dir: string, env: Record<string, string> = {}): { status: number | null; config: any; stderr: string } {
  const code = `import("${url("src", "config.ts")}").then((m) => console.log(JSON.stringify({ port: m.config.port, motd: m.config.motd, maxPlayers: m.config.maxPlayers, viewDistance: m.config.viewDistance, generator: m.config.generator, seed: m.config.seed, mapFolder: m.config.mapFolder, protect: m.config.lobby.protectWorld, whitelist: m.config.whitelist, pvp: m.config.pvp, respawn: m.config.respawn, checkForUpdates: m.config.checkForUpdates, requiredPlugins: m.config.requiredPlugins })))`;
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (key.startsWith("QUARRY_") || key === "SERVER_PORT") delete cleanEnv[key];
  const result = spawnSync(process.execPath, [tsxBin, "-e", code], { cwd: dir, encoding: "utf8", env: { ...cleanEnv, ...env } });
  return { status: result.status, config: result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").pop()!) : null, stderr: result.stderr };
}

// ---------------------------------------------------------------- the first start writes every setting
{
  const dir = tempFolder();
  const said = ensure(dir);
  assert.deepStrictEqual(read(dir), DEFAULT_SETTINGS, "a new config.json has every setting at its default");
  assert.ok(said.some((line) => line.includes("Created config.json")), "and the console says so");
  const keys = Object.keys(read(dir));
  for (const wanted of ["port", "motd", "maxPlayers", "viewDistance", "generator", "seed", "mapFolder", "protectWorld", "whitelist", "pvp", "respawn", "checkForUpdates", "requiredPlugins"]) {
    assert.ok(keys.includes(wanted), `config.json lists ${wanted}`);
  }
  assert.strictEqual(read(dir).pvp, true, "pvp is on by default");

  // Nothing to add: the file is left exactly as it is (even if the player formatted it differently).
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(DEFAULT_SETTINGS)); // one line, no pretty printing
  const before = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  assert.deepStrictEqual(ensure(dir), [], "a complete file is not touched and nothing is said");
  assert.strictEqual(fs.readFileSync(path.join(dir, "config.json"), "utf8"), before);

  // The server runs with exactly these defaults when there is no file at all.
  const empty = tempFolder();
  const loaded = loadConfig(empty);
  assert.strictEqual(loaded.status, 0, loaded.stderr);
  assert.deepStrictEqual(
    loaded.config,
    {
      port: 25565, motd: DEFAULT_SETTINGS.motd, maxPlayers: 20, viewDistance: 6, generator: "natural", seed: null, mapFolder: "", protect: false,
      whitelist: false, pvp: true, respawn: { immediate: false, keepInventory: true, deathMessages: true }, checkForUpdates: true, requiredPlugins: [],
    },
    "the defaults in config.json and the defaults the server uses without it are the same",
  );
  console.log("ok the first start writes every setting, and the defaults agree");
}

// ---------------------------------------------------------------- an update adds settings, and keeps yours
{
  const dir = tempFolder();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 4000, motd: "Mine", protectWorld: true, respawn: { immediate: true }, myOwnNote: "keep me" }, null, 2));
  const said = ensure(dir);
  const now = read(dir);
  assert.strictEqual(now.port, 4000, "your values stay");
  assert.strictEqual(now.motd, "Mine");
  assert.strictEqual(now.protectWorld, true);
  assert.strictEqual(now.respawn.immediate, true, "also inside respawn");
  assert.strictEqual(now.respawn.keepInventory, true, "a missing setting inside respawn is added");
  assert.strictEqual(now.pvp, true, "a whole new setting is added");
  assert.strictEqual(now.myOwnNote, "keep me", "keys this version does not know are kept");
  assert.ok(said.some((line) => line.includes("added the new settings") && line.includes("pvp") && line.includes("respawn.keepInventory") && !line.includes("port")), "the console lists what was added, and only that");
  assert.deepStrictEqual(ensure(dir), [], "and the next start has nothing to add");
  console.log("ok an update adds the new settings and keeps yours");
}

// ---------------------------------------------------------------- the old server.json is taken over
{
  const dir = tempFolder();
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 4001, protectWorld: true, seed: 77 }));
  assert.strictEqual(loadConfig(dir).config.port, 4001, "until config.json exists, server.json is read");
  const said = ensure(dir);
  const now = read(dir);
  assert.strictEqual(now.port, 4001);
  assert.strictEqual(now.protectWorld, true);
  assert.strictEqual(now.seed, 77);
  assert.strictEqual(now.pvp, true, "the new settings come with it");
  assert.ok(!fs.existsSync(path.join(dir, "server.json")) && fs.existsSync(path.join(dir, "server.json.old")), "the old file is kept under another name, so there is one source of truth");
  assert.ok(said.some((line) => line.includes("moved into config.json")));
  assert.strictEqual(loadConfig(dir).config.port, 4001);

  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 9999 }));
  assert.strictEqual(loadConfig(dir).config.port, 4001, "when both exist, config.json wins");
  console.log("ok server.json is taken over");
}

// ---------------------------------------------------------------- reading the settings
{
  const dir = tempFolder();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...DEFAULT_SETTINGS, pvp: false, respawn: { immediate: true, keepInventory: false, deathMessages: false }, seed: 5, mapFolder: "maps/lobby", whitelist: true, requiredPlugins: ["worldedit"] }));
  const loaded = loadConfig(dir);
  assert.strictEqual(loaded.status, 0, loaded.stderr);
  assert.strictEqual(loaded.config.pvp, false);
  assert.deepStrictEqual(loaded.config.respawn, { immediate: true, keepInventory: false, deathMessages: false });
  assert.strictEqual(loaded.config.seed, 5);
  assert.strictEqual(loaded.config.mapFolder, "maps/lobby");
  assert.strictEqual(loaded.config.whitelist, true);
  assert.deepStrictEqual(loaded.config.requiredPlugins, ["worldedit"]);

  // null means "not set": a random seed, no map.
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ seed: null, mapFolder: null, pvp: null, respawn: { immediate: null } }));
  const unset = loadConfig(dir);
  assert.strictEqual(unset.status, 0, unset.stderr);
  assert.strictEqual(unset.config.seed, null);
  assert.strictEqual(unset.config.mapFolder, "");
  assert.strictEqual(unset.config.pvp, true, "null falls back to the default");
  assert.strictEqual(unset.config.respawn.immediate, false);

  for (const [bad, message] of [
    [{ pvp: "maybe" }, "pvp must be true or false"],
    [{ respawn: true }, "respawn must be an object"],
    [{ respawn: { keepInventory: 3 } }, "respawn.keepInventory must be true or false"],
    [{ checkForUpdates: "sometimes" }, "checkForUpdates must be true or false"],
    [{ port: 99999 }, "the port must be a whole number"],
  ] as const) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(bad));
    const result = loadConfig(dir);
    assert.notStrictEqual(result.status, 0, `${JSON.stringify(bad)} is refused`);
    assert.ok(result.stderr.includes(message), `with a clear message (${message}): ${result.stderr.slice(0, 200)}`);
  }
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
  const broken = loadConfig(dir);
  assert.notStrictEqual(broken.status, 0);
  assert.ok(broken.stderr.includes("config.json"), "a damaged file is an error that names the file");
  assert.throws(() => ensure(dir), /Cannot use config.json/, "and it is not overwritten");
  assert.strictEqual(fs.readFileSync(path.join(dir, "config.json"), "utf8"), "{ not json");
  console.log("ok reading the settings, and mistakes");
}

// ---------------------------------------------------------------- the panel's variables
{
  const dir = tempFolder();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...DEFAULT_SETTINGS, maxPlayers: 30, protectWorld: true, port: 4000 }));
  assert.strictEqual(loadConfig(dir, { QUARRY_MAX_PLAYERS: "", QUARRY_PROTECT_WORLD: "", QUARRY_GENERATOR: "" }).config.maxPlayers, 30, "an empty variable leaves the file in charge");
  const overridden = loadConfig(dir, { QUARRY_MAX_PLAYERS: "10", QUARRY_PROTECT_WORLD: "false", SERVER_PORT: "25570" }).config;
  assert.strictEqual(overridden.maxPlayers, 10, "a filled-in variable wins");
  assert.strictEqual(overridden.protect, false);
  assert.strictEqual(overridden.port, 25570, "the panel's own port always wins");
  assert.strictEqual(loadConfig(dir, { QUARRY_CHECK_UPDATES: "false" }).config.checkForUpdates, true, "settings that are only in config.json have no variable");
  console.log("ok panel variables still override");
}

console.log("ALL CONFIG FILE CHECKS PASS");
