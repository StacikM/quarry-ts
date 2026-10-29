/** Run: npx tsx scripts/plugins-check.ts (no sockets or filesystem writes). */
import assert from "node:assert/strict";
import { EventBus } from "../src/plugins/EventBus";
import { CommandRegistry } from "../src/plugins/CommandRegistry";
import { builtinPlugins } from "../src/plugins/builtin";
import { homePlugin } from "../src/plugins/builtin/home";
import { runCommand } from "../src/game/commands";
import type { PluginApi } from "../src/plugins/types";
import type { Player } from "../src/game/Player";
import { handlePlay } from "../src/protocol/handlers/play";
import { PlayIn } from "../src/protocol/packetIds";
import type { Connection } from "../src/network/Connection";
import type { PacketReader } from "../src/network/PacketReader";

const events = new EventBus();
const commands = new CommandRegistry();
const saved = new Map<string, unknown>();
const broadcasts: string[] = [];
const messages: string[] = [];
const server = {
  getSpawnPoint: () => ({ x: 0.5, y: 73, z: 0.5 }),
  broadcastMessage: (text: string) => broadcasts.push(text),
  plugins: { events, commands },
};
function api(owner: string): PluginApi {
  return {
    server: server as unknown as PluginApi["server"],
    logger: { info() {}, warn() {}, error() {} },
    on: (event, handler) => events.on(owner, event, handler),
    registerCommand: (command) => commands.register(owner, command),
    runLater() {}, runRepeating() {},
    loadData: <T>(fallback: T, validate?: (v: unknown) => v is T): T => {
      const value = saved.get(owner);
      return value === undefined || (validate && !validate(value)) ? fallback : value as T;
    },
    saveData: (value) => { saved.set(owner, structuredClone(value)); },
  };
}
const player = {
  username: "Tester", x: 100, y: 80, z: -25, isOp: false, server,
  sendMessage: (text: string) => messages.push(text),
  teleport(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; },
};
const asPlayer = player as unknown as Player;
for (const plugin of builtinPlugins) plugin.onEnable(api(plugin.name));
runCommand(asPlayer, "home");
assert.match(messages.pop()!, /Set a home/);
runCommand(asPlayer, "sethome");
player.x = 300;
runCommand(asPlayer, "home");
assert.equal(player.x, 100);
commands.removeAll(homePlugin.name);
homePlugin.onEnable(api(homePlugin.name));
player.username = "TESTER";
player.x = 200;
runCommand(asPlayer, "home");
assert.equal(player.x, 100, "case-insensitive persisted home");
const previousHome = structuredClone(saved.get(homePlugin.name));
player.y = Infinity;
runCommand(asPlayer, "sethome");
assert.deepEqual(saved.get(homePlugin.name), previousHome, "reject invalid coordinates");
player.y = 80;
runCommand(asPlayer, "setwarp market");
assert.equal(saved.has("warps"), false, "non-op cannot set a warp");
player.isOp = true;
runCommand(asPlayer, "setwarp Market");
assert(saved.has("warps"));
player.x = -200;
player.isOp = false;
runCommand(asPlayer, "warp MARKET");
assert.equal(player.x, 100);
runCommand(asPlayer, "warp constructor");
assert.match(messages.pop()!, /Unknown warp/);
runCommand(asPlayer, "warps");
assert.match(messages.pop()!, /market/);
for (const eventName of ["blockBreak", "blockPlace"] as const) {
  const emit = (x: number) => events.emit(eventName, {
    player: asPlayer, position: { x, y: 72, z: 0 }, blockId: 1, metadata: 0, cancelled: false,
  });
  assert.equal(emit(0).cancelled, true);
  assert.equal(emit(16).cancelled, true);
  assert.equal(emit(17).cancelled, false);
  player.isOp = true;
  assert.equal(emit(0).cancelled, false);
  player.isOp = false;
}
events.emit("playerJoin", { player: asPlayer });
assert(messages.some((message) => message.includes("Welcome, TESTER")));
runCommand(asPlayer, "rules");
assert(messages.some((message) => message.includes("Do not grief")));
saved.set(homePlugin.name, { bad: { x: null, y: 80, z: 0 }, tester: { x: 1, y: 73, z: 2 } });
commands.removeAll(homePlugin.name);
homePlugin.onEnable(api(homePlugin.name));
runCommand(asPlayer, "home");
assert.equal(player.x, 1, "valid disk entry survives malformed sibling");
events.on("external-filter", "playerChat", (event) => {
  if (event.message.includes("badword")) event.cancelled = true;
  event.message = event.message.replace(/spoiler/g, "***");
});
function chat(message: string): void {
  handlePlay({ player: asPlayer } as Connection, PlayIn.ChatMessage, { readString: () => message } as PacketReader);
}
chat("hello {player}");
assert.equal(broadcasts.pop(), "\u00a77[Player] \u00a7f<TESTER> \u00a77hello {player}");
player.isOp = true;
chat("spoiler");
assert.equal(broadcasts.pop(), "\u00a7c[OP] \u00a7f<TESTER> \u00a77***", "late filter rewrite is formatted");
chat("badword");
assert.equal(broadcasts.length, 0, "late moderation cancels before broadcast");
console.log("Builtin checks passed: homes/persistence/validation, warp permissions, protection boundaries, welcome/rules, formatted chat with later filtering/cancellation.");
