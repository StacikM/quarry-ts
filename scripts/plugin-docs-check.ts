/** Executes every JS example in docs/PLUGINS.md, using only a fresh temp directory. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const originalDirectory = process.cwd();
const guide = fs.readFileSync(path.join(originalDirectory, "docs/PLUGINS.md"), "utf8");
const examples = [...guide.matchAll(/^```js\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]);
// A fresh fixture under the workspace also permits atomic replacement in the Windows sandbox.
const directory = fs.mkdtempSync(path.join(originalDirectory, ".plugin-docs-check-"));
process.chdir(directory);

async function main(): Promise<void> {
  // Import after chdir: the manager's plugin/data folders resolve inside the fixture.
  const { PluginManager } = await import("../src/plugins/PluginManager");
  const { runCommand } = await import("../src/game/commands");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PlayIn } = await import("../src/protocol/packetIds");
  const messages: string[] = [], broadcasts: string[] = [];
  const players: any[] = [];
  const server: any = {
    getSpawnPoint: () => ({ x: 0.5, y: 73, z: 0.5 }),
    getPlayerByName: (name: string) => players.find((p) => p.username.toLowerCase() === name.toLowerCase()),
    broadcastMessage: (text: string) => broadcasts.push(text),
  };
  const manager = new PluginManager(server);
  server.plugins = manager;
  const alice: any = {
    username: "Alice", uuid: "alice-id", x: 0, y: 73, z: 0, isOp: false, server,
    sendMessage: (text: string) => messages.push(text),
    teleport(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; },
  };
  const bob = { username: "Bob", uuid: "bob-id", x: 100, y: 80, z: -20 };
  players.push(alice, bob);
  const plugins = examples.map((source, i) => {
    const module = { exports: {} as any };
    vm.runInNewContext(source, { module, exports: module.exports }, { filename: `guide-example-${i + 1}.js`, timeout: 1000 });
    const plugin = module.exports;
    manager.enable(plugin);
    assert(manager.getEnabledNames().includes(plugin.name), `enable example ${i + 1}`);
    return plugin;
  });
  assert.equal(plugins.length, 7);
  runCommand(alice, "guidehello");
  assert.equal(messages.pop(), "Hello, Alice!");
  runCommand(alice, "notice test");
  assert.equal(broadcasts.length, 0, "opOnly enforced");
  alice.isOp = true;
  runCommand(alice, "notice hello world");
  assert.equal(broadcasts.pop(), "[Notice] hello world");
  alice.isOp = false;
  for (const eventName of ["blockBreak", "blockPlace"] as const) {
    const payload = { player: alice, position: { x: 24, y: 100, z: 0 }, blockId: 1, metadata: 0, cancelled: false };
    assert.equal(manager.events.emit(eventName, payload).cancelled, true);
    assert.equal(manager.events.emit(eventName, { ...payload, cancelled: false, position: { x: 25, y: 100, z: 0 } }).cancelled, false);
    alice.isOp = true;
    assert.equal(manager.events.emit(eventName, { ...payload, cancelled: false }).cancelled, false);
    alice.isOp = false;
  }
  fs.mkdirSync("plugins-data", { recursive: true });
  fs.writeFileSync("plugins-data/guide-visits.json", '{"visits":"broken"}');
  manager.disable("guide-visits");
  manager.enable(plugins.find((plugin) => plugin.name === "guide-visits"));
  manager.events.emit("playerJoin", { player: alice });
  assert.equal(JSON.parse(fs.readFileSync("plugins-data/guide-visits.json", "utf8")).visits, 1);
  manager.disable("guide-visits");
  manager.enable(plugins.find((plugin) => plugin.name === "guide-visits"));
  manager.events.emit("playerJoin", { player: alice });
  assert.equal(JSON.parse(fs.readFileSync("plugins-data/guide-visits.json", "utf8")).visits, 2);
  for (let i = 0; i < 40; i++) manager.scheduler.tick();
  assert(messages.includes("Try /help for commands."));
  runCommand(alice, "visit nobody");
  runCommand(alice, "visit Bob");
  assert.equal(alice.x, 100);
  alice.x = 0;
  runCommand(alice, "visit Bob");
  assert.equal(alice.x, 0, "cooldown prevents second teleport");
  for (let i = 0; i < 200; i++) manager.scheduler.tick();
  runCommand(alice, "visit Bob");
  assert.equal(alice.x, 100, "cooldown expires after 200 ticks");
  manager.events.on("late-moderation", "playerChat", (event) => {
    if (event.message.includes("blocked")) event.cancelled = true;
    event.message = event.message.replace(/secret/g, "***");
  });
  const chat = (text: string) => handlePlay({ player: alice } as any, PlayIn.ChatMessage, { readString: () => text } as any);
  chat("secret {player}");
  assert.equal(broadcasts.pop(), "\u00a77[Member] \u00a7f<Alice> \u00a77*** {player}");
  chat("blocked");
  assert.equal(broadcasts.length, 0);
  for (let i = 0; i < 960; i++) manager.scheduler.tick();
  assert(broadcasts.includes("Use /rules to read the rules."));
  manager.disableAll();
  const before = broadcasts.length;
  for (let i = 0; i < 1200; i++) manager.scheduler.tick();
  assert.equal(broadcasts.length, before, "disable cancels repeating tasks");
  assert.equal(manager.commands.all().length, 0);
  console.log(`Plugin guide: all ${examples.length} examples passed behavior checks in a temporary directory.`);
}

main().finally(() => {
  process.chdir(originalDirectory);
  // Verify this cleanup can only target our fresh fixture directly under the workspace.
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(originalDirectory) || !path.basename(resolved).startsWith(".plugin-docs-check-")) {
    throw new Error("Refusing cleanup outside the plugin guide fixture");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
