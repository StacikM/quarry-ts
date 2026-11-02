/**
 * Checks TNT: lighting it, the fall and the fuse, which blocks an explosion destroys, chain reactions, how hard
 * players are thrown, and the plugin event that can protect blocks.
 * Run with:  npx tsx scripts/explosion-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-explosion-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { config } = await import("../src/config");
  const { defaultState } = await import("../src/world/blockStates");
  const { lobbyPlugin } = await import("../src/plugins/builtin/lobby");
  const { pendingLogin, readerFor } = await import("./support/fakeClient");

  type Packet = InstanceType<typeof PacketWriter>;
  type Pos = { x: number; y: number; z: number };

  const server = new MinecraftServer();
  const world = server.world;
  const tnt = defaultState("tnt");
  const air = defaultState("air");
  const stone = defaultState("stone");
  const dirt = defaultState("dirt");
  const obsidian = defaultState("obsidian");
  const bedrock = defaultState("bedrock");
  const flower = defaultState("dandelion");
  server.explosions.random = () => 0.5; // every ray has exactly the strength of the power

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
  alice.player.gameMode = GameMode.Creative;
  const bob = client("Bob", "00000000-0000-0000-0000-000000000002");
  const FAR = 1000;
  Object.assign(alice.player, { x: FAR, y: 150, z: FAR });
  Object.assign(bob.player, { x: -FAR, y: 150, z: -FAR }); // both far from everything, until a test moves one

  const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
  const stateAt = (x: number, y: number, z: number): number => world.getState({ x, y, z });
  /** A solid cube of `state` around (cx, cy, cz), `radius` blocks to each side. */
  const fill = (cx: number, cy: number, cz: number, radius: number, state: number): void => {
    for (let y = cy - radius; y <= cy + radius; y++) for (let z = cz - radius; z <= cz + radius; z++) for (let x = cx - radius; x <= cx + radius; x++) world.setBlock(at(x, y, z), state);
  };
  const tick = (times: number): void => {
    for (let i = 0; i < times; i++) server.explosions.tick();
  };
  const useOn = (who: typeof alice, pos: Pos, item: string): void => {
    who.player.setInventorySlot(36, null);
    who.player.give(item, 1);
    who.player.heldSlot = 0;
    const packet = new PacketWriter(PlayIn.UseItemOn).writeVarInt(0).writePosition(pos).writeVarInt(1).writeFloat(0.5).writeFloat(1).writeFloat(0.5).writeBoolean(false).writeBoolean(false).writeVarInt(1);
    handlePlay(who.conn, PlayIn.UseItemOn, readerFor(packet));
  };
  /** The knockback an Explosion packet carries (null for none), and how many blocks it says were destroyed. */
  const readBlast = (packet: Packet): { knockback: Pos | null; blocks: number } => {
    const body = packet.body(); // packet id (one byte), centre (3 doubles), radius (float), block count (int), then the optional knockback
    const flag = 1 + 24 + 4 + 4;
    return {
      blocks: body.readInt32BE(1 + 24 + 4),
      knockback: body.readUInt8(flag) === 0 ? null : { x: body.readDoubleBE(flag + 1), y: body.readDoubleBE(flag + 9), z: body.readDoubleBE(flag + 17) },
    };
  };
  const blastsFor = (who: typeof alice): Packet[] => who.sent.filter((p) => p.packetId === PlayOut.Explosion);

  const Y = 150;

  // ---------------------------------------------------------------- lighting
  fill(0, Y, 0, 3, stone);
  world.setBlock(at(0, Y + 1, 0), tnt);
  alice.sent.length = 0;
  bob.sent.length = 0;
  useOn(alice, at(0, Y + 1, 0), "stone");
  assert.strictEqual(stateAt(0, Y + 1, 0), tnt, "a stone block does not light TNT");
  assert.strictEqual(server.explosions.litCount, 0);
  useOn(alice, at(0, Y + 1, 0), "flint_and_steel");
  assert.strictEqual(stateAt(0, Y + 1, 0), air, "flint and steel turns the TNT block into lit TNT");
  assert.strictEqual(server.explosions.litCount, 1);
  assert.strictEqual(alice.sent.filter((p) => p.packetId === PlayOut.SpawnEntity).length, 1, "everybody sees it appear");
  assert.ok(alice.sent.some((p) => p.packetId === PlayOut.SetEntityData), "with its fuse and look");
  assert.ok(bob.sent.some((p) => p.packetId === PlayOut.SpawnEntity), "also the other players");
  assert.strictEqual(server.explosions.lit()[0].fuse, 80);

  // Somebody who joins now sees it too.
  const carol = client("Carol", "00000000-0000-0000-0000-000000000003");
  server.explosions.showAllTo(carol.player);
  assert.deepStrictEqual(carol.sent.map((p) => p.packetId), [PlayOut.SpawnEntity, PlayOut.SetEntityData], "a player who joins sees TNT that is already lit");
  server.onConnectionClosed(carol.conn);

  // ---------------------------------------------------------------- the jump, the fuse and the explosion
  const before = alice.sent.length;
  tick(5);
  assert.ok(alice.sent.slice(before).some((p) => p.packetId === PlayOut.EntityPositionSync), "it hops, and the clients are told where it is");
  assert.ok(server.explosions.lit()[0].y > Y + 1, "it is in the air for a moment");
  tick(10);
  assert.strictEqual(server.explosions.lit()[0].y, Y + 1, "and lands on the block again");
  assert.strictEqual(server.explosions.lit()[0].fuse, 65);
  alice.sent.length = 0;
  tick(64);
  assert.strictEqual(server.explosions.litCount, 1, "one tick to go");
  assert.strictEqual(blastsFor(alice).length, 0);
  tick(1);
  assert.strictEqual(server.explosions.litCount, 0, "after 80 ticks it is gone...");
  assert.strictEqual(blastsFor(alice).length, 1, "...with one explosion");
  assert.ok(alice.sent.some((p) => p.packetId === PlayOut.RemoveEntities), "the lit TNT disappears from the screens");
  assert.strictEqual(stateAt(0, Y + 1, 0), air);
  assert.strictEqual(stateAt(0, Y, 0), air, "the stone it stood on is hit hardest");
  assert.strictEqual(stateAt(3, Y - 3, 3), stone, "far corners are untouched");
  console.log("ok lighting, the hop, the fuse and the explosion");

  // ---------------------------------------------------------------- which blocks go
  fill(0, Y, 0, 8, dirt);
  fill(0, Y, 0, 0, air);
  assert.ok((server.explosions.explode(0.5, Y + 0.5, 0.5, 4) ?? 0) > 20, "a crater");
  assert.strictEqual(stateAt(1, Y, 0), air);
  assert.strictEqual(stateAt(0, Y + 2, 0), air, "two blocks away: gone");
  assert.strictEqual(stateAt(0, Y, 6), dirt, "six blocks away: the rays have run out of strength");
  assert.strictEqual(stateAt(7, Y + 7, 7), dirt);
  console.log("ok the crater");

  fill(0, Y, 0, 8, dirt);
  fill(0, Y, 0, 2, obsidian);
  fill(0, Y, 0, 1, air);
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(stateAt(2, Y, 0), obsidian, "obsidian holds");
  assert.strictEqual(stateAt(0, Y, 4), dirt, "and shields what is behind it");
  assert.strictEqual(stateAt(1, Y, 0), air);
  fill(0, Y, 0, 8, dirt);
  fill(0, Y, 0, 0, air);
  world.setBlock(at(0, Y - 1, 0), bedrock);
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(stateAt(0, Y - 1, 0), bedrock, "bedrock never breaks");
  console.log("ok obsidian and bedrock");

  // ---------------------------------------------------------------- what stood on the blocks falls with them
  fill(0, Y, 0, 8, dirt);
  fill(0, Y, 0, 0, air);
  world.setBlock(at(0, Y + 3, 0), dirt);
  world.setBlock(at(0, Y + 4, 0), flower);
  world.setBlock(at(6, Y + 3, 0), dirt); // out of reach: its flower stays
  world.setBlock(at(6, Y + 4, 0), flower);
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(stateAt(0, Y + 3, 0), air);
  assert.strictEqual(stateAt(0, Y + 4, 0), air, "a flower whose ground was destroyed breaks too");
  assert.strictEqual(stateAt(6, Y + 4, 0), flower, "one whose ground is safe stays");
  console.log("ok plants fall with their ground");

  // ---------------------------------------------------------------- chain reaction
  fill(0, Y, 0, 8, air);
  world.setBlock(at(1, Y, 0), tnt);
  world.setBlock(at(0, Y, 2), tnt);
  world.setBlock(at(7, Y, 0), tnt); // too far
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(server.explosions.litCount, 2, "TNT inside the blast is lit, TNT outside is not");
  assert.strictEqual(stateAt(7, Y, 0), tnt);
  for (const lit of server.explosions.lit()) assert.ok(lit.fuse >= 10 && lit.fuse < 30, "with a short fuse");
  tick(30);
  assert.strictEqual(server.explosions.litCount, 0, "and they go off in turn");
  console.log("ok chain reaction");

  // ---------------------------------------------------------------- falling
  fill(0, Y, 0, 8, air);
  fill(0, Y - 1, 0, 3, stone); // the floor's top is at Y + 2
  world.setBlock(at(0, Y + 6, 0), tnt);
  assert.ok(server.explosions.ignite(at(0, Y + 6, 0)));
  assert.ok(!server.explosions.ignite(at(0, Y + 6, 0)), "there is no TNT block left to light");
  tick(30);
  assert.strictEqual(server.explosions.lit()[0].y, Y + 3, "lit TNT in mid-air falls and stops on the floor");
  const fuseLeft = server.explosions.lit()[0].fuse;
  world.setBlock(at(0, Y + 2, 0), air);
  tick(1);
  tick(10);
  assert.ok(server.explosions.lit()[0].y < Y + 3, "when its floor is blown away it falls again");
  tick(fuseLeft);
  assert.strictEqual(server.explosions.litCount, 0);
  console.log("ok falling");

  // ---------------------------------------------------------------- throwing players back
  fill(0, Y, 0, 8, air);
  Object.assign(bob.player, { x: 2.5, y: Y, z: 0.5 });
  alice.sent.length = 0;
  bob.sent.length = 0;
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  const hit = readBlast(blastsFor(bob)[0]);
  assert.ok(hit.knockback, "a player two blocks away is thrown");
  assert.ok(hit.knockback!.x > 0.3 && Math.abs(hit.knockback!.z) < 0.01, "away from the blast (east of it)");
  assert.ok(hit.knockback!.y > 0, "and up a little, because his head is higher than the middle of the blast");
  assert.strictEqual(readBlast(blastsFor(alice)[0]).knockback, null, "a player far away only hears it");

  alice.sent.length = 0;
  Object.assign(alice.player, { x: 2.5, y: Y, z: 0.5, flying: true });
  Object.assign(bob.player, { x: -FAR, z: -FAR });
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(readBlast(blastsFor(alice)[0]).knockback, null, "a flying creative player is not pushed");
  alice.player.flying = false;
  Object.assign(alice.player, { x: FAR, z: FAR });

  // A wall in between shields.
  Object.assign(bob.player, { x: 4.5, y: Y, z: 0.5 });
  for (let y = Y - 3; y <= Y + 4; y++) for (let z = -3; z <= 3; z++) world.setBlock(at(2, y, z), obsidian);
  bob.sent.length = 0;
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.strictEqual(readBlast(blastsFor(bob)[0]).knockback, null, "a wall in the way stops the push");
  Object.assign(bob.player, { x: -FAR, z: -FAR });
  console.log("ok knockback");

  // ---------------------------------------------------------------- plugins can protect blocks
  fill(0, Y, 0, 8, air);
  fill(0, Y, 0, 3, dirt);
  fill(0, Y, 0, 0, air);
  const seen: string[] = [];
  server.plugins.events.on("test", "explosion", (event) => {
    seen.push(`${event.position.x},${event.position.y},${event.position.z} p${event.power} ${event.blocks.length > 0}`);
    event.blocks = event.blocks.filter((pos) => pos.x !== 1 || pos.y !== Y || pos.z !== 0);
  });
  server.explosions.explode(0.5, Y + 0.5, 0.5, 4);
  assert.deepStrictEqual(seen, ["0.5,150.5,0.5 p4 true"], "the event gets the centre, the power and the blocks");
  assert.strictEqual(stateAt(1, Y, 0), dirt, "a block taken out of the list stays");
  assert.strictEqual(stateAt(-1, Y, 0), air, "the others go");
  server.plugins.events.removeAll("test");

  fill(0, Y, 0, 3, dirt);
  server.plugins.events.on("test", "explosion", (event) => {
    event.cancelled = true;
  });
  alice.sent.length = 0;
  assert.strictEqual(server.explosions.explode(0.5, Y + 0.5, 0.5, 4), null, "cancelled");
  assert.strictEqual(stateAt(1, Y, 0), dirt);
  assert.strictEqual(blastsFor(alice).length, 0, "no sound either");
  server.plugins.events.removeAll("test");

  // Lighting counts as breaking: a plugin that protects blocks can refuse it.
  world.setBlock(at(5, Y + 6, 5), tnt);
  server.plugins.events.on("test", "blockBreak", (event) => {
    event.cancelled = true;
  });
  useOn(alice, at(5, Y + 6, 5), "flint_and_steel");
  assert.strictEqual(stateAt(5, Y + 6, 5), tnt, "TNT in a protected place stays unlit");
  server.plugins.events.removeAll("test");
  alice.player.gameMode = GameMode.Adventure;
  useOn(alice, at(5, Y + 6, 5), "flint_and_steel");
  assert.strictEqual(stateAt(5, Y + 6, 5), tnt, "players in adventure mode cannot light it");
  alice.player.gameMode = GameMode.Survival;
  useOn(alice, at(5, Y + 6, 5), "fire_charge");
  assert.strictEqual(stateAt(5, Y + 6, 5), air, "a fire charge works too");
  tick(80);
  console.log("ok plugins can protect blocks");

  // ---------------------------------------------------------------- the lobby
  fill(0, Y, 0, 3, dirt);
  config.lobby.protectWorld = true;
  server.plugins.enable(lobbyPlugin);
  assert.strictEqual(server.explosions.explode(0.5, Y + 0.5, 0.5, 4), null, "in a protected lobby nothing is destroyed");
  assert.strictEqual(stateAt(1, Y, 0), dirt);
  server.plugins.disable("lobby");
  config.lobby.protectWorld = false;
  console.log("ok the lobby is safe");

  assert.ok(stone !== obsidian);
  console.log("ALL EXPLOSION CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("EXPLOSION CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
