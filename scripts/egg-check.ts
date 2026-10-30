/**
 * Checks the Pterodactyl egg (pterodactyl/egg-quarry-ts.json): that it is up to date with what
 * pterodactyl/build-egg.cjs makes, that it is a well-formed egg, that every setting it offers is one the
 * server really reads, and that the install script is valid shell.
 * Run with:  npx tsx scripts/egg-check.ts
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (...parts: string[]): string => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { egg: expected } = require(path.join(root, "pterodactyl", "build-egg.cjs"));
const egg = JSON.parse(read("pterodactyl", "egg-quarry-ts.json"));

assert.deepStrictEqual(egg, JSON.parse(JSON.stringify(expected)), "egg-quarry-ts.json is out of date: run  node pterodactyl/build-egg.cjs");
console.log("ok the egg file matches build-egg.cjs and install.sh");

assert.strictEqual(egg.meta.version, "PTDL_v2");
assert.ok(egg.startup.startsWith("node dist/index.js"), "it starts the built server");
assert.strictEqual(egg.config.stop, "stop", "the panel's Stop button types the console command that saves the world");
assert.strictEqual(JSON.parse(egg.config.startup).done, "Listening on", "the panel waits for the line the server prints when it is ready");
for (const image of Object.values<string>(egg.docker_images)) assert.match(image, /^ghcr\.io\/parkervcp\/yolks:nodejs_(2[4-9]|[3-9]\d)$/, "Node.js 24 or newer");
assert.match(egg.scripts.installation.container, /^node:(2[4-9]|[3-9]\d)/, "the installer container has Node.js 24 or newer");
assert.strictEqual(egg.scripts.installation.entrypoint, "bash");

const sources = ["src/config.ts", "src/game/createWorld.ts", "src/index.ts"].map((file) => read(...file.split("/"))).join("\n");
const installScript: string = egg.scripts.installation.script;
for (const variable of egg.variables) {
  assert.ok(variable.name && variable.description && variable.rules, `${variable.env_variable} has a name, a description and rules`);
  assert.match(variable.env_variable, /^[A-Z][A-Z0-9_]*$/);
  const used = sources.includes(variable.env_variable) || installScript.includes(variable.env_variable);
  assert.ok(used, `${variable.env_variable} is offered in the panel but nothing reads it`);
  // The default must pass the rule the panel will check it with.
  const rules: string[] = variable.rules.split("|");
  if (rules.includes("required")) assert.notStrictEqual(variable.default_value, "", `${variable.env_variable} is required, so it needs a default`);
  const allowed = rules.find((rule) => rule.startsWith("in:"))?.slice(3).split(",");
  if (allowed) assert.ok(allowed.includes(variable.default_value), `the default of ${variable.env_variable} is one of its allowed values`);
  const between = rules.find((rule) => rule.startsWith("between:"))?.slice(8).split(",").map(Number);
  if (between) assert.ok(Number(variable.default_value) >= between[0] && Number(variable.default_value) <= between[1], `the default of ${variable.env_variable} is in range`);
}
const names = new Set<string>(egg.variables.map((variable: { env_variable: string }) => variable.env_variable));
assert.strictEqual(names.size, egg.variables.length, "no variable is listed twice");
console.log(`ok the egg offers ${names.size} variables and the server reads all of them`);

// The other way round: every QUARRY_ setting the server understands can be set from the panel.
// (Not the port: the panel gives every server its own SERVER_PORT, which the server uses.)
for (const match of sources.matchAll(/\bQUARRY_[A-Z_]+/g)) {
  if (match[0] === "QUARRY_PORT") continue;
  assert.ok(names.has(match[0]), `the server reads ${match[0]} but the egg does not offer it`);
}
assert.ok(/SERVER_PORT/.test(read("src", "config.ts")), "the panel's own SERVER_PORT is the port");
console.log("ok everything the server can be told by environment is in the egg");

// A syntax check of the install script, when a bash is around.
const bash = spawnSync("bash", ["-n"], { input: installScript, encoding: "utf8" });
if (bash.error) console.log("skipped: no bash to check the install script's syntax");
else {
  assert.strictEqual(bash.status, 0, `install script is not valid shell: ${bash.stderr}`);
  console.log("ok the install script is valid shell");
}

// The scripts for people installing by hand.
const installSh = read("install.sh");
assert.ok(installSh.startsWith("#!/usr/bin/env bash\n"), "install.sh has a shebang");
const shell = spawnSync("bash", ["-n"], { input: installSh, encoding: "utf8" });
if (!shell.error) assert.strictEqual(shell.status, 0, `install.sh is not valid shell: ${shell.stderr}`);
assert.ok(read("install.bat").includes("scripts\\setup.cjs"), "install.bat runs the setup");
assert.ok(installSh.includes("scripts/setup.cjs"), "install.sh runs the setup");
console.log("ALL EGG CHECKS PASS");
