import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quarry-whitelist-check-"));
process.chdir(temp);
async function main() {
  const { Whitelist, whitelistFor } = await import("../src/game/whitelist");
  const { config } = await import("../src/config");
  const { adminCommands } = await import("../src/game/adminCommands");
  const { runConsoleCommand } = await import("../src/consoleCommands");
  const list = new Whitelist();
  assert.equal(list.enabled, false);
  list.add("ExamplePlayer");
  list.setEnabled(true);
  assert(list.allows("eXaMpLePlAyEr"));
  assert(!list.allows("Visitor"));
  assert.equal(list.add("../oops"), "invalid");
  assert.equal(list.add("EXAMPLEPLAYER"), "already");
  config.ops.push("ExampleOp");
  assert(list.allows("exampleop"));
  assert(new Whitelist().enabled);
  assert.equal(new Whitelist().list().length, 1);
  assert(
    new Whitelist(path.resolve("whitelist.json"), false).enabled,
    "installer default must not erase persisted enable",
  );
  fs.writeFileSync(
    "whitelist.json",
    JSON.stringify({ enabled: true, names: ["Valid", null, "bad name", "VALID"] }),
  );
  list.reload();
  assert.deepEqual(list.list(), ["VALID"]);
  fs.writeFileSync("whitelist.json", "{broken");
  assert.throws(() => list.reload());
  assert(list.enabled);
  assert(list.allows("valid"));
  fs.unlinkSync("whitelist.json");
  list.reload();
  assert(list.enabled);
  const badPath = path.join(temp, "directory");
  fs.mkdirSync(badPath);
  assert.throws(() => new Whitelist(badPath));
  const failures = new Whitelist(path.join(temp, "missing", "list.json"));
  assert.throws(() => failures.setEnabled(true));
  assert.equal(failures.enabled, false);
  const kicked: string[] = [],
    replies: string[] = [];
  const online = ["Visitor", "ExampleOp", "Listed"].map((username) => ({
    username,
    kick: () => kicked.push(username),
  }));
  const command = adminCommands.find((c) => c.name === "whitelist")!;
  assert(command.opOnly);
  assert(command.runConsole);
  const server: any = {
    getOnlinePlayers: () => online,
    plugins: { commands: { get: (name: string) => (name === "whitelist" ? command : undefined) } },
  };
  server.console = {
    server,
    name: "Console",
    isOp: true,
    isConsole: true,
    sendMessage: (m: string) => replies.push(m),
  };
  whitelistFor(server).add("Listed");
  runConsoleCommand(server, "whitelist on");
  assert.deepEqual(kicked, ["Visitor"]);
  assert(replies.pop()!.includes("Kicked 1"));
  kicked.length = 0;
  runConsoleCommand(server, "whitelist remove listed");
  assert.deepEqual(kicked, ["Visitor", "Listed"]);
  runConsoleCommand(server, "whitelist off");
  assert(!whitelistFor(server).enabled);
  runConsoleCommand(server, "whitelist reload");
  assert(!whitelistFor(server).enabled);
  const { handleLogin } = await import("../src/protocol/handlers/login");
  const { LoginIn } = await import("../src/protocol/packetIds");
  whitelistFor(server).setEnabled(true);
  server.bans = { findNameBan: () => undefined, findIpBan: () => undefined };
  const conn: any = {
    server,
    protocolVersion: 774,
    velocityMessageId: null,
    clientIp: "127.0.0.1",
    address: "test",
    disconnect: (text: string) => replies.push(text),
  };
  handleLogin(conn, LoginIn.LoginStart, { readString: () => "Visitor", readUUID: () => "ignored" } as any);
  assert.equal(replies.pop(), "You are not whitelisted on this server.");
  console.log(
    "Whitelist: persistence, case folding, operator bypass, reload/save failures, console enforcement and login denial pass.",
  );
}
main().finally(() => {
  process.chdir(root);
  if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith("quarry-whitelist-check-"))
    throw Error("Unsafe cleanup");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
