/**
 * Checks death and respawn: pvp on and off, the death screen and message, what a dead player cannot do, the Respawn
 * button, the plugin events that choose where and with what a player comes back, /kill, and the config.json switches.
 * Run with:  npx tsx scripts/respawn-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-respawn-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { config } = await import("../src/config");
  const { runCommand } = await import("../src/game/commands");
  const { defaultState, itemId } = await import("../src/world/blockStates");
  const { chatText, pendingLogin, readerFor } = await import("./support/fakeClient");

  type Packet = InstanceType<typeof PacketWriter>;

  const server = new MinecraftServer();
  const world = server.world;

  function client(name: string, uuid: string): { conn: any; sent: Packet[]; player: any } {
    const sent: Packet[] = [];
    const conn = { player: null as unknown, address: "test", clientIp: "127.0.0.1", send: (p: Packet) => sent.push(p), compressionThreshold: -1, sendFrame: () => {}, disconnect: () => {} };
    server.addPlayer(conn as never, pendingLogin(name, uuid));
    const player = conn.player as any;
    player.awaitingTeleport = null;
    player.gameMode = GameMode.Survival;
    sent.length = 0;
    return { conn, sent, player };
  }
  const alice = client("Alice", "00000000-0000-0000-0000-000000000001");
  const bob = client("Bob", "00000000-0000-0000-0000-000000000002");
  config.ops.push("Alice");

  const ids = (who: typeof alice): number[] => who.sent.map((p) => p.packetId);
  const messages = (who: typeof alice): string[] => who.sent.map(chatText).filter((t): t is string => t !== null);
  const clear = (): void => {
    alice.sent.length = 0;
    bob.sent.length = 0;
  };
  const press = (who: typeof alice, action: number): void => {
    handlePlay(who.conn, PlayIn.ClientCommand, readerFor(new PacketWriter(PlayIn.ClientCommand).writeVarInt(action)));
  };

  // ---------------------------------------------------------------- pvp
  assert.strictEqual(config.pvp, true, "pvp is on by default");
  assert.strictEqual(bob.player.combat.damage(4, alice.player, "melee"), true, "players hurt each other by default");
  assert.ok(bob.player.combat.health < 20);
  bob.player.combat.reset();

  config.pvp = false;
  assert.strictEqual(bob.player.combat.damage(4, alice.player, "melee"), false, "with pvp off, a player's damage is cancelled");
  assert.strictEqual(bob.player.combat.health, 20);
  assert.strictEqual(bob.player.combat.damage(4, undefined, "fall"), true, "but damage that is nobody's attack still counts");
  bob.player.combat.reset();
  server.plugins.events.on("duel", "playerDamage", (event) => {
    event.cancelled = false; // a duel plugin may allow it inside its arena
  });
  assert.strictEqual(bob.player.combat.damage(4, alice.player, "melee"), true, "a plugin can allow it again");
  server.plugins.events.removeAll("duel");
  bob.player.combat.reset();
  config.pvp = true;
  console.log("ok pvp");

  // ---------------------------------------------------------------- dying
  clear();
  assert.strictEqual(bob.player.combat.damage(100, alice.player, "melee"), true);
  assert.strictEqual(bob.player.dead, true);
  assert.strictEqual(bob.player.isDead, true);
  assert.strictEqual(bob.player.combat.health, 0);
  assert.ok(ids(bob).includes(PlayOut.DeathCombatEvent), "the dying player gets the death screen");
  assert.ok(alice.sent.some((p) => p.packetId === PlayOut.EntityStatus), "everybody else sees the death animation");
  assert.ok(messages(alice).includes("Bob was slain by Alice") && messages(bob).includes("Bob was slain by Alice"), "and reads how it happened");
  assert.strictEqual(bob.player.combat.damage(5, alice.player, "melee"), false, "a dead player cannot be hurt again");
  assert.strictEqual(bob.player.combat.kill(), false, "or killed again");
  console.log("ok dying");

  // ---------------------------------------------------------------- what a dead player cannot do
  const stone = defaultState("stone");
  const air = defaultState("air");
  world.setBlock({ x: 3, y: 150, z: 3 }, stone);
  handlePlay(bob.conn, PlayIn.PlayerAction, readerFor(new PacketWriter(PlayIn.PlayerAction).writeVarInt(2).writePosition({ x: 3, y: 150, z: 3 }).writeByte(1).writeVarInt(1)));
  assert.strictEqual(world.getState({ x: 3, y: 150, z: 3 }), stone, "a dead player does not break blocks");
  bob.player.x = 50;
  handlePlay(bob.conn, PlayIn.PlayerPosition, readerFor(new PacketWriter(PlayIn.PlayerPosition).writeDouble(99).writeDouble(150).writeDouble(99).writeByte(1)));
  assert.strictEqual(bob.player.x, 50, "or move");
  clear();
  handlePlay(bob.conn, PlayIn.ChatMessage, readerFor(new PacketWriter(PlayIn.ChatMessage).writeString("hello from beyond")));
  assert.ok(messages(alice).some((m) => m.includes("hello from beyond")), "but can still chat");
  console.log("ok a dead player is frozen");

  // ---------------------------------------------------------------- respawn
  let seenEvents: string[] = [];
  server.plugins.events.on("check", "playerRespawn", (event) => seenEvents.push(`before keep=${event.keepInventory} at ${event.position.x},${event.position.y},${event.position.z}`));
  server.plugins.events.on("check", "playerRespawned", (event) => seenEvents.push(`after dead=${event.player.dead} health=${event.player.combat.health}`));
  bob.player.give("stone", 5);
  clear();
  const spawn = server.getSpawnPoint();
  press(bob, 0);
  assert.strictEqual(bob.player.dead, false);
  assert.strictEqual(bob.player.combat.health, 20, "full health");
  assert.deepStrictEqual(seenEvents, [`before keep=true at ${spawn.x},${spawn.y},${spawn.z}`, "after dead=false health=20"], "the events fire around it, with the defaults of config.json");
  assert.deepStrictEqual([bob.player.x, bob.player.y, bob.player.z], [spawn.x, spawn.y, spawn.z], "at the world spawn");
  const got = ids(bob);
  assert.ok(got.includes(PlayOut.Respawn), "the client starts a new life");
  assert.ok(got.indexOf(PlayOut.Respawn) < got.indexOf(PlayOut.ContainerContent), "and is then told its inventory again (it forgot it)");
  assert.ok(got.includes(PlayOut.PlayerPosition) && got.includes(PlayOut.ChunkBatchStart), "where to stand, and the chunks around it again (the chunk bytes themselves go out as raw frames)");
  assert.ok(alice.sent.some((p) => p.packetId === PlayOut.RemoveEntities) && alice.sent.some((p) => p.packetId === PlayOut.SpawnEntity), "the others see the body go and the player appear");
  assert.strictEqual(bob.player.inventory.get(36)?.itemId, itemId("stone"), "the items were kept");
  assert.strictEqual(bob.player.respawn(), false, "a player who is alive cannot respawn");
  press(bob, 1);
  assert.strictEqual(bob.player.dead, false, "the statistics button does nothing");
  console.log("ok respawning");

  // ---------------------------------------------------------------- plugins choose where, and what is kept
  seenEvents = [];
  server.plugins.events.removeAll("check");
  server.plugins.events.on("check", "playerRespawn", (event) => {
    event.position = { x: 100.5, y: 70, z: -20.5, yaw: 90, pitch: 5 };
    event.keepInventory = false;
  });
  bob.player.combat.kill("void");
  assert.ok(messages(alice).includes("Bob fell out of the world"), "the cause decides the sentence");
  press(bob, 0);
  assert.deepStrictEqual([bob.player.x, bob.player.y, bob.player.z, bob.player.yaw, bob.player.pitch], [100.5, 70, -20.5, 90, 5], "a plugin chooses the place");
  assert.strictEqual(bob.player.inventory.get(36), null, "and can take the items");

  server.plugins.events.removeAll("check");
  server.plugins.events.on("check", "playerRespawn", (event) => {
    event.position = { x: NaN, y: 70, z: 0 };
  });
  bob.player.kill();
  assert.strictEqual(bob.player.respawn(), true, "player.respawn() brings a dead player back without the button");
  assert.deepStrictEqual([bob.player.x, bob.player.z], [spawn.x, spawn.z], "an impossible place falls back to the spawn");
  server.plugins.events.removeAll("check");
  console.log("ok plugins choose where players come back");

  // ---------------------------------------------------------------- death messages
  server.plugins.events.on("check", "playerDeath", (event) => {
    event.message = `${event.player.username} got got by ${event.killer?.username ?? "nobody"} (${event.cause})`;
  });
  clear();
  bob.player.combat.damage(100, alice.player, "arrow");
  assert.ok(messages(alice).includes("Bob got got by Alice (arrow)"), "a plugin can write the message");
  bob.player.respawn();
  server.plugins.events.removeAll("check");
  server.plugins.events.on("check", "playerDeath", (event) => {
    event.message = null;
  });
  clear();
  bob.player.kill();
  assert.deepStrictEqual(messages(alice), [], "or say nothing");
  assert.ok(ids(bob).includes(PlayOut.DeathCombatEvent), "though the death screen still shows");
  bob.player.respawn();
  server.plugins.events.removeAll("check");
  config.respawn.deathMessages = false;
  clear();
  bob.player.kill();
  assert.deepStrictEqual(messages(alice), [], "deathMessages: false in config.json silences them");
  config.respawn.deathMessages = true;
  bob.player.respawn();
  console.log("ok death messages");

  // ---------------------------------------------------------------- a plugin can keep a player alive
  server.plugins.events.on("check", "playerDeath", (event) => {
    event.cancelled = true;
  });
  const before = alice.player.combat.health;
  assert.strictEqual(alice.player.combat.damage(100, bob.player, "melee"), false);
  assert.strictEqual(alice.player.dead, false);
  assert.strictEqual(alice.player.combat.health, before, "cancelling the death keeps the health");
  assert.strictEqual(alice.player.kill(), false);
  server.plugins.events.removeAll("check");
  console.log("ok cancelling a death");

  // ---------------------------------------------------------------- /kill and creative mode
  bob.player.gameMode = GameMode.Creative;
  assert.strictEqual(bob.player.combat.damage(100, alice.player, "melee"), false, "creative players are not hurt by damage...");
  clear();
  runCommand(alice.player, "kill Bob");
  assert.strictEqual(bob.player.dead, true, "...but /kill kills them");
  bob.player.respawn();
  assert.strictEqual(bob.player.gameMode, GameMode.Creative);
  clear();
  runCommand(bob.player, "kill");
  assert.ok(messages(bob).some((m) => /permission/.test(m)), "only operators can use it");
  assert.strictEqual(bob.player.dead, false);
  runCommand(alice.player, "kill");
  assert.strictEqual(alice.player.dead, true, "without a name, it is for yourself");
  runCommand(alice.player, "kill Nobody");
  alice.player.respawn();
  console.log("ok /kill");

  // ---------------------------------------------------------------- the death screen can be skipped
  alice.sent.length = 0;
  const { joinGame } = await import("../src/protocol/clientbound");
  const screenFlag = (packet: Packet): number => packet.body()[1 + 4 + 1 + 1 + 1 + "minecraft:overworld".length + 1 + 1 + 1 + 1]; // after the entity id, hardcore, world list, max players and distances
  assert.notStrictEqual(joinGame(1, GameMode.Survival, 20, 6, true).body().length, 0);
  assert.strictEqual(screenFlag(joinGame(1, GameMode.Survival, 20, 6, true)), 1, "the respawn screen is on by default");
  assert.strictEqual(screenFlag(joinGame(1, GameMode.Survival, 20, 6, false)), 0, "and respawn.immediate turns it off");
  console.log("ok immediate respawn flag");

  assert.ok(air !== stone);
  console.log("ALL RESPAWN CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("RESPAWN CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
