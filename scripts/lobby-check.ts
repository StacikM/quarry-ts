/**
 * Checks the lobby features: the void world, the world protection for non-operators,
 * and asking a Velocity proxy to move a player to another server.
 * Run with:  npx tsx scripts/lobby-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or ops.json.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-lobby-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { World } = await import("../src/world/World");
  const { VoidGenerator, VOID_PLATFORM_Y } = await import("../src/world/VoidGenerator");
  const { Block } = await import("../src/world/blocks");
  const { MinecraftServer } = await import("../src/game/Server");
  const { GameMode } = await import("../src/game/GameMode");
  const { config } = await import("../src/config");
  const { lobbyPlugin } = await import("../src/plugins/builtin/lobby");
  const { PlayOut } = await import("../src/protocol/packetIds");
  const { pendingLogin } = await import("./support/fakeClient");
  const { createDeserializer } = require("minecraft-protocol/src/transforms/serializer");

  // ---------------------------------------------------------------- the void world
  {
    const world = new World(new VoidGenerator());
    const at = (x: number, y: number, z: number) => ({ x, y, z });
    assert.strictEqual(world.getState(at(0, VOID_PLATFORM_Y, 0)), Block.Stone, "the platform is under the spawn");
    assert.strictEqual(world.getState(at(-3, VOID_PLATFORM_Y, 3)), Block.Stone, "and reaches 3 blocks in every direction, across chunk borders");
    assert.strictEqual(world.getState(at(4, VOID_PLATFORM_Y, 0)), Block.Air, "but no further");
    assert.strictEqual(world.getState(at(0, VOID_PLATFORM_Y + 1, 0)), Block.Air);
    assert.strictEqual(world.getState(at(100, VOID_PLATFORM_Y, 100)), Block.Air, "everything else is empty");
    assert.strictEqual(world.getSpawnHeight(0, 0), VOID_PLATFORM_Y + 1, "players spawn standing on the platform");
    console.log("ok void world: a small platform at the spawn and nothing else");
  }

  // ---------------------------------------------------------------- protection
  const server = new MinecraftServer();
  const join = (name: string, uuidEnd: string): { player: any; sent: Array<{ packetId: number; body(): Buffer }> } => {
    const sent: Array<{ packetId: number; body(): Buffer }> = [];
    const connection = { player: null as unknown, address: "test", clientIp: "127.0.0.1", send: (packet: any) => sent.push(packet), compressionThreshold: -1, sendFrame: () => {}, disconnect: () => {} };
    server.addPlayer(connection as never, pendingLogin(name, "00000000-0000-0000-0000-00000000000" + uuidEnd));
    return { player: connection.player, sent };
  };
  {
    config.ops.push("Boss");
    const visitor = join("Visitor", "1");
    const boss = join("Boss", "2");
    const events = server.plugins.events;
    const breakAt = (player: any) => events.emit("blockBreak", { player, position: { x: 0, y: 70, z: 0 }, state: Block.Stone, cancelled: false });
    const placeAt = (player: any) => events.emit("blockPlace", { player, position: { x: 0, y: 70, z: 0 }, state: Block.Stone, cancelled: false });

    // Off by default: nothing is blocked.
    server.plugins.enable(lobbyPlugin);
    assert.strictEqual(breakAt(visitor.player).cancelled, false, "without the setting the plugin does nothing");
    server.plugins.disable("lobby");

    config.lobby.protectWorld = true;
    server.plugins.enable(lobbyPlugin);
    assert.strictEqual(breakAt(visitor.player).cancelled, true, "visitors cannot break blocks");
    assert.strictEqual(placeAt(visitor.player).cancelled, true, "or place them");
    assert.strictEqual(breakAt(boss.player).cancelled, false, "operators can break");
    assert.strictEqual(placeAt(boss.player).cancelled, false, "and place");

    const late = join("Latecomer", "3");
    assert.strictEqual(late.player.gameMode, GameMode.Adventure, "newcomers join in adventure mode");
    config.ops.push("Boss2");
    const op = join("Boss2", "4");
    assert.notStrictEqual(op.player.gameMode, GameMode.Adventure, "operators keep their game mode");
    server.plugins.disable("lobby");
    config.lobby.protectWorld = false;
    console.log("ok lobby protection: visitors cannot build, operators can, newcomers are in adventure mode, off by default");
  }

  // ---------------------------------------------------------------- moving to another server
  {
    const { player, sent } = join("Traveller", "5");
    sent.length = 0;
    player.connectToServer("survival-1");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].packetId, PlayOut.PluginMessage);
    const frame = sent[0].body();
    const decoded = createDeserializer({ state: "play", isServer: false, version: "1.21.11", noErrorLogging: true }).parsePacketBuffer(frame).data.params;
    assert.strictEqual(decoded.channel, "bungeecord:main");
    // Java's DataInput format, as the proxy reads it: "Connect" and then the server name.
    const data: Buffer = decoded.data;
    const strings: string[] = [];
    for (let at = 0; at < data.length; ) {
      const length = data.readUInt16BE(at);
      strings.push(data.toString("utf8", at + 2, at + 2 + length));
      at += 2 + length;
    }
    assert.deepStrictEqual(strings, ["Connect", "survival-1"]);
    assert.throws(() => player.connectToServer("bad name!"), /Invalid server name/);
    assert.throws(() => player.connectToServer(""), /Invalid server name/);
    console.log("ok connectToServer sends the proxy a Connect message, and refuses odd server names");
  }

  console.log("ALL LOBBY CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("LOBBY CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
