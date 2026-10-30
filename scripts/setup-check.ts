/**
 * Checks the interactive setup (scripts/setup.cjs), the settings file the server reads (server.json and the
 * environment variables hosting panels use) and the random seed that every new server gets.
 * Run with:  npx tsx scripts/setup-check.ts
 *
 * Everything happens in temporary folders, so it never touches your real settings or world/.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(__dirname, "..");
const setupScript = path.join(root, "scripts", "setup.cjs");
const tsxBin = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

/** A file: URL for a file in the project, which is what import() wants on every system. */
const url = (...parts: string[]): string => pathToFileURL(path.join(root, ...parts)).href;

function tempFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-setup-"));
}

/** Runs the setup in `cwd`, typing `answers` (one line each) as if a person did. */
function runSetup(cwd: string, answers: string[], args: string[] = []): string {
  const result = spawnSync(process.execPath, [setupScript, ...args], { cwd, input: answers.join("\n") + "\n", encoding: "utf8" });
  assert.strictEqual(result.status, 0, `setup failed: ${result.stderr}`);
  return result.stdout;
}

/** The settings the server would run with in `cwd` (loaded in a separate process, as a real start would). */
function loadConfig(cwd: string, env: Record<string, string> = {}): { status: number | null; config: any; stderr: string } {
  const code = `import("${url("src", "config.ts")}").then((m) => console.log(JSON.stringify({ port: m.config.port, motd: m.config.motd, maxPlayers: m.config.maxPlayers, viewDistance: m.config.viewDistance, generator: m.config.generator, seed: m.config.seed, whitelist: m.config.whitelist, ops: m.config.ops })))`;
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (key.startsWith("QUARRY_") || key === "SERVER_PORT") delete cleanEnv[key];
  const result = spawnSync(process.execPath, [tsxBin, "-e", code], { cwd, encoding: "utf8", env: { ...cleanEnv, ...env } });
  return { status: result.status, config: result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").pop()!) : null, stderr: result.stderr };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- a flat server with a whitelist
  let dir = tempFolder();
  runSetup(dir, [
    "25570", "My server", "50", "8", // port, motd, players, view distance
    "2", // flat world
    "y", // whitelist
    "ExampleOp, Alex", // operators
  ]);
  const server = JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  assert.deepStrictEqual(server, { port: 25570, motd: "My server", maxPlayers: 50, viewDistance: 8, generator: "flat", whitelist: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "ops.json"), "utf8")), ["ExampleOp", "Alex"]);
  let loaded = loadConfig(dir);
  assert.strictEqual(loaded.status, 0, loaded.stderr);
  assert.strictEqual(loaded.config.whitelist, true);
  assert.strictEqual(loadConfig(dir, { QUARRY_WHITELIST: "false" }).config.whitelist, false);
  assert.notStrictEqual(loadConfig(dir, { QUARRY_WHITELIST: "yes" }).status, 0);
  assert.deepStrictEqual(
    { port: loaded.config.port, generator: loaded.config.generator, maxPlayers: loaded.config.maxPlayers, viewDistance: loaded.config.viewDistance, motd: loaded.config.motd },
    { port: 25570, generator: "flat", maxPlayers: 50, viewDistance: 8, motd: "My server" },
    "the server really runs with what was typed",
  );
  assert.deepStrictEqual(loaded.config.ops, ["ExampleOp", "Alex"]);
  console.log("ok setup: the answers are written to server.json and ops.json, and the server reads them back");

  // ---------------------------------------------------------------- mistakes are asked again; Enter takes the default
  dir = tempFolder();
  const retry = runSetup(dir, ["99999", "abc", "", "", "", "", "9", "1", "", "n", ""]);
  assert.ok(retry.includes("The port must be a whole number"), "a bad port is explained");
  assert.ok(retry.includes("The choice must be a whole number from 1 to 2"), "so is a bad menu choice");
  const defaults = JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  assert.strictEqual(defaults.generator, "natural");
  assert.strictEqual(defaults.whitelist, false);
  assert.strictEqual(defaults.port, 25565, "Enter keeps the default");
  assert.ok(!("seed" in defaults), "no seed typed means: let the server make a random one");
  assert.ok(!fs.existsSync(path.join(dir, "ops.json")), "no operators: no such file");
  console.log("ok setup: wrong answers are asked again, Enter takes the default, nothing unasked is written");

  // ---------------------------------------------------------------- defaults only, and ended input
  dir = tempFolder();
  runSetup(dir, [], ["--defaults"]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")).port, 25565);
  dir = tempFolder();
  spawnSync(process.execPath, [setupScript], { cwd: dir, input: "", encoding: "utf8" }); // input ends at once
  assert.ok(fs.existsSync(path.join(dir, "server.json")), "when the input ends, the rest of the questions take their defaults");
  console.log("ok setup: --defaults and ended input work");

  // ---------------------------------------------------------------- an existing server.json is not overwritten without asking
  dir = tempFolder();
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 4000 }));
  runSetup(dir, ["n"]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")).port, 4000, "answering no leaves the file alone");
  runSetup(dir, ["y"], ["--defaults"]); // defaults mode does not ask
  console.log("ok setup: an existing server.json is kept unless you say so");

  // ---------------------------------------------------------------- a typed seed
  dir = tempFolder();
  runSetup(dir, ["", "", "", "", "1", "12345", "", ""]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")).seed, 12345);
  console.log("ok setup: a seed answer is saved");

  // ---------------------------------------------------------------- settings: files, environment, mistakes
  dir = tempFolder();
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 4000, seed: "hello", maxPlayers: 5 }));
  loaded = loadConfig(dir);
  assert.strictEqual(loaded.config.port, 4000);
  assert.strictEqual(loaded.config.maxPlayers, 5);
  const textSeed = loaded.config.seed;
  assert.ok(Number.isInteger(textSeed), "a text seed becomes a number");
  assert.strictEqual(loadConfig(dir).config.seed, textSeed, "the same way every time");

  loaded = loadConfig(dir, { QUARRY_PORT: "5000", QUARRY_SEED: "42", QUARRY_GENERATOR: "flat", QUARRY_MOTD: "From the panel", QUARRY_OPS: "Panel, Admin" });
  assert.strictEqual(loaded.config.port, 5000, "environment variables win over the file");
  assert.strictEqual(loaded.config.seed, 42);
  assert.strictEqual(loaded.config.generator, "flat");
  assert.strictEqual(loaded.config.motd, "From the panel");
  assert.deepStrictEqual(loaded.config.ops, ["Panel", "Admin"]);
  assert.strictEqual(loadConfig(dir, { SERVER_PORT: "6000" }).config.port, 6000, "a panel's SERVER_PORT is used when nothing else sets the port");
  assert.strictEqual(loadConfig(dir, { QUARRY_PORT: "", QUARRY_SEED: "", QUARRY_MOTD: "" }).config.port, 4000, "empty variables count as not set");

  assert.notStrictEqual(loadConfig(tempFolder(), { QUARRY_PORT: "70000" }).status, 0, "a port out of range stops the server");
  assert.notStrictEqual(loadConfig(tempFolder(), { QUARRY_GENERATOR: "mountains" }).status, 0, "so does an unknown generator");
  const broken = tempFolder();
  fs.writeFileSync(path.join(broken, "server.json"), "{ not json");
  const brokenLoad = loadConfig(broken);
  assert.notStrictEqual(brokenLoad.status, 0, "a damaged server.json is an error, not silently ignored");
  assert.ok(brokenLoad.stderr.includes("server.json"), "which names the file");
  console.log("ok settings: server.json, environment variables (SERVER_PORT too) and mistakes");

  // ---------------------------------------------------------------- a random seed per server, kept across restarts
  const seeds = new Set<number>();
  for (let i = 0; i < 4; i++) {
    const folder = tempFolder();
    const seed = Number(createSeed(folder));
    assert.ok(Number.isInteger(seed));
    assert.strictEqual(Number(fs.readFileSync(path.join(folder, "world", "seed.txt"), "utf8")), seed, "the seed is kept in world/seed.txt");
    assert.strictEqual(Number(createSeed(folder)), seed, "and the next start reuses it, so the world comes back");
    seeds.add(seed);
  }
  assert.ok(seeds.size > 1, "different servers get different seeds");
  const fixed = tempFolder();
  fs.writeFileSync(path.join(fixed, "server.json"), JSON.stringify({ seed: 99 }));
  assert.strictEqual(createSeed(fixed), "99", "a seed in server.json is used as it is");
  assert.ok(!fs.existsSync(path.join(fixed, "world", "seed.txt")), "and nothing random is made");
  console.log("ok seed: random per server, remembered across restarts, server.json wins");

  console.log("ALL SETUP CHECKS PASS");
}

/** Starts world creation in `cwd` the way a real start does and returns the seed it ended up with. */
function createSeed(cwd: string): string {
  const code = `Promise.all([import("${url("src", "game", "createWorld.ts")}"), import("${url("src", "config.ts")}")]).then(([w, c]) => { w.createWorld(); console.log("SEED=" + c.config.seed); })`;
  const cleanEnv = { ...process.env };
  delete cleanEnv.QUARRY_SEED;
  const result = spawnSync(process.execPath, [tsxBin, "-e", code], { cwd, encoding: "utf8", env: cleanEnv });
  assert.strictEqual(result.status, 0, result.stderr);
  return /SEED=(-?\d+)/.exec(result.stdout)![1];
}

main().catch((err) => {
  console.error("SETUP CHECK FAILED:", err);
  process.exitCode = 1;
});
