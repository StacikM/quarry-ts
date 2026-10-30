/** Executes every JS example in the plugin guide (docs/plugins/*.md), using only a fresh temp directory. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stateOf } from "../src/world/blockStates";

const originalDirectory = process.cwd();
// The guide is one page per topic; the pages are read in file name order (01-..., 02-...), so the examples keep their order.
const guideFolder = path.join(originalDirectory, "docs", "plugins");
const guide = fs
  .readdirSync(guideFolder)
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => fs.readFileSync(path.join(guideFolder, file), "utf8"))
  .join("\n");
const examples = [...guide.matchAll(/^```js\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]);
// A fresh fixture under the workspace also permits atomic replacement in the Windows sandbox.
const directory = fs.mkdtempSync(path.join(originalDirectory, ".plugin-docs-check-"));
process.chdir(directory);

async function main(): Promise<void> {
  // Import after chdir: the manager's plugin/data folders resolve inside the fixture.
  const { PluginManager } = await import("../src/plugins/PluginManager");
  const { NpcManager } = await import('../src/game/NpcManager');
  const { runCommand } = await import("../src/game/commands");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PlayIn } = await import("../src/protocol/packetIds");
  const messages: string[] = [], broadcasts: string[] = [];
  const players: any[] = [];
  let nextEntityId = 1;
  const server: any = {
    allocateEntityId: () => nextEntityId++,
    getOnlinePlayers: () => players,
    getSpawnPoint: () => ({ x: 0.5, y: 73, z: 0.5 }),
    getPlayerByName: (name: string) => players.find((p) => p.username.toLowerCase() === name.toLowerCase()),
    broadcastMessage: (text: string) => broadcasts.push(text),
  };
  server.npcs = new NpcManager(server);
  const manager = new PluginManager(server);
  server.plugins = manager;
  const alice: any = {
    username: "Alice", uuid: "alice-id", x: 0, y: 73, z: 0, isOp: false, server,
    sendMessage: (text: string) => messages.push(text),
    send: () => {}, // NPCs are shown to every player: a real player receives packets
    teleport(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; },
  };
  const bob = { username: "Bob", uuid: "bob-id", x: 100, y: 80, z: -20, send: () => {} };
  players.push(alice, bob);
  const plugins = examples.map((source, i) => {
    const module = { exports: {} as any };
    vm.runInNewContext(source, { module, exports: module.exports }, { filename: `guide-example-${i + 1}.js`, timeout: 1000 });
    const plugin = module.exports;
    manager.enable(plugin);
    assert(manager.getEnabledNames().includes(plugin.name), `enable example ${i + 1}`);
    return plugin;
  });
  assert.equal(plugins.length, 8);
  runCommand(alice, "guidehello");
  assert.equal(messages.pop(), "Hello, Alice!");
  // The NPC example spawns its NPC, which answers clicks.
  const greeter = server.npcs.get("guide-greeter");
  assert(greeter, "the NPC example spawns its NPC");
  assert.equal(greeter.definition.equipment?.head?.item, "leather_helmet");
  assert.equal(greeter.definition.equipment?.head?.dyedColor, 0xcc2222);
  manager.events.emit("npcInteract", { player: alice, npc: greeter, click: "right", sneaking: false });
  assert.equal(messages.pop(), "Hello, Alice!");
  manager.events.emit("npcInteract", { player: alice, npc: greeter, click: "left", sneaking: false });
  assert.equal(messages.pop(), "Ouch!");
  runCommand(alice, "notice test");
  assert.equal(broadcasts.length, 0, "opOnly enforced");
  alice.isOp = true;
  runCommand(alice, "notice hello world");
  assert.equal(broadcasts.pop(), "[Notice] hello world");
  alice.isOp = false;
  for (const eventName of ["blockBreak", "blockPlace"] as const) {
    const payload = { player: alice, position: { x: 24, y: 100, z: 0 }, state: stateOf('stone'), cancelled: false };
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
  assert.equal(server.npcs.list().length, 0, "disabling the plugins removes their NPCs");
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
