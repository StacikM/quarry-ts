/**
 * Checks the WorldGuard plugin: regions, who may build in them, flags, priorities, walking in and out, and saving.
 * Run with:  npx tsx scripts/worldguard-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-worldguard-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { config } = await import("../src/config");
  const { runCommand } = await import("../src/game/commands");
  const { defaultState } = await import("../src/world/blockStates");
  const { worldEditPlugin } = await import("../src/plugins/builtin/worldedit");
  const { worldGuardPlugin } = await import("../src/plugins/builtin/worldguard");
  const { checkBuild, readRegions } = await import("../src/plugins/builtin/worldguard/regions");
  const { chatText, pendingLogin, readerFor } = await import("./support/fakeClient");

  type Packet = InstanceType<typeof PacketWriter>;
  type Pos = { x: number; y: number; z: number };

  const server = new MinecraftServer();
  server.plugins.enable(worldEditPlugin);
  server.plugins.enable(worldGuardPlugin);
  const world = server.world;
  const stone = defaultState("stone");
  const air = defaultState("air");

  function client(name: string, uuid: string): { conn: any; sent: Packet[]; player: any } {
    const sent: Packet[] = [];
    const conn = { player: null as unknown, address: "test", clientIp: "127.0.0.1", send: (p: Packet) => sent.push(p), compressionThreshold: -1, sendFrame: () => {}, disconnect: () => {} };
    server.addPlayer(conn as never, pendingLogin(name, uuid));
    const player = conn.player as any;
    player.awaitingTeleport = null;
    player.gameMode = GameMode.Creative;
    sent.length = 0;
    return { conn, sent, player };
  }
  const alice = client("Alice", "00000000-0000-0000-0000-000000000001");
  const bob = client("Bob", "00000000-0000-0000-0000-000000000002");
  config.ops.push("Alice");

  const messages = (who: typeof alice): string[] => who.sent.map(chatText).filter((t): t is string => t !== null);
  const say = (who: typeof alice, command: string): string => {
    who.sent.length = 0;
    runCommand(who.player, command);
    return messages(who).join(" | ");
  };
  const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
  const stateAt = (x: number, y: number, z: number): number => world.getState({ x, y, z });
  const stand = (who: typeof alice, x: number, y: number, z: number): void => Object.assign(who.player, { x: x + 0.5, y, z: z + 0.5 });
  const dig = (who: typeof alice, pos: Pos): void => {
    handlePlay(who.conn, PlayIn.PlayerAction, readerFor(new PacketWriter(PlayIn.PlayerAction).writeVarInt(0).writePosition(pos).writeByte(1).writeVarInt(1)));
  };
  const place = (who: typeof alice, clicked: Pos): void => {
    who.player.give("stone", 1);
    who.player.heldSlot = 0;
    const packet = new PacketWriter(PlayIn.UseItemOn).writeVarInt(0).writePosition(clicked).writeVarInt(1).writeFloat(0.5).writeFloat(1).writeFloat(0.5).writeBoolean(false).writeBoolean(false).writeVarInt(1);
    handlePlay(who.conn, PlayIn.UseItemOn, readerFor(packet));
  };
  /** Bob places a block on top of a stone block, and the block is either there or not. */
  const bobCanPlace = (x: number, y: number, z: number): boolean => {
    world.setBlock(at(x, y - 1, z), stone);
    place(bob, at(x, y - 1, z));
    const placed = stateAt(x, y, z) === stone;
    world.setBlock(at(x, y, z), air);
    world.setBlock(at(x, y - 1, z), air);
    return placed;
  };
  /** The client reports a new position, like every tick. */
  const walk = (who: typeof alice, x: number, y: number, z: number): void => {
    who.player.awaitingTeleport = null;
    handlePlay(who.conn, PlayIn.PlayerPosition, readerFor(new PacketWriter(PlayIn.PlayerPosition).writeDouble(x).writeDouble(y).writeDouble(z).writeByte(1)));
  };

  const Y = 150;
  /** Bob digs where a stone block is, and the stone is either still there or gone. */
  const bobCanBreak = (x: number, y: number, z: number): boolean => {
    world.setBlock(at(x, y, z), stone);
    dig(bob, at(x, y, z));
    const broke = stateAt(x, y, z) === air;
    world.setBlock(at(x, y, z), air);
    return broke;
  };

  // ---------------------------------------------------------------- making a region
  assert.match(say(alice, "rg define spawn"), /Select the area first/, "a region needs a selection");
  stand(alice, 0, Y, 0);
  say(alice, "/pos1");
  stand(alice, 9, Y + 5, 9);
  say(alice, "/pos2");
  assert.match(say(alice, "rg define spawn"), /Region spawn defined/);
  assert.match(say(alice, "rg define spawn"), /already a region/);
  assert.match(say(alice, "rg define Bad!"), /1-32 letters/);
  assert.match(say(alice, "region list"), /Regions \(1\): spawn/);
  assert.match(say(bob, "rg list"), /permission/, "only operators manage regions");
  console.log("ok defining a region");

  // ---------------------------------------------------------------- who may build
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false, "a region with no flags: only its owners and members build");
  assert.strictEqual(bobCanBreak(20, Y + 1, 20), true, "outside any region everybody builds");
  bob.sent.length = 0;
  assert.strictEqual(bobCanPlace(5, Y + 1, 5), false, "placing is refused as well");
  assert.match(messages(bob).join("|"), /Sorry, but you can't build here/, "and he is told why");
  assert.strictEqual(bobCanPlace(20, Y + 1, 20), true);

  say(alice, "rg addmember spawn Bob");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "a member can build");
  say(alice, "rg removemember spawn bob");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false);
  say(alice, "rg addowner spawn BOB");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "so can an owner");
  assert.match(say(alice, "rg info spawn"), /Owners: bob/);
  say(alice, "rg removeowner spawn bob");
  assert.match(say(alice, "rg addmember spawn not a name!"), /not a player name/);

  // Operators ignore regions, unless they ask not to.
  world.setBlock(at(5, Y + 1, 5), stone);
  dig(alice, at(5, Y + 1, 5));
  assert.strictEqual(stateAt(5, Y + 1, 5), air, "operators build anywhere");
  say(alice, "rg bypass off");
  world.setBlock(at(5, Y + 1, 5), stone);
  dig(alice, at(5, Y + 1, 5));
  assert.strictEqual(stateAt(5, Y + 1, 5), stone, "...until they turn the bypass off");
  say(alice, "rg bypass on");
  world.setBlock(at(5, Y + 1, 5), air);
  console.log("ok owners, members and operators");

  // ---------------------------------------------------------------- flags
  assert.match(say(alice, "rg flag spawn build allow"), /now: allow/);
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "build allow: everybody");
  say(alice, "rg flag spawn build deny");
  say(alice, "rg addmember spawn bob");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false, "build deny: nobody, not even members");
  say(alice, "rg flag spawn block-break allow");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "block-break wins over build for breaking");
  assert.strictEqual(bobCanPlace(5, Y + 1, 5), false, "but not for placing");
  say(alice, "rg flag spawn block-break");
  say(alice, "rg flag spawn build");
  say(alice, "rg removemember spawn bob");
  assert.match(say(alice, "rg flag spawn build maybe"), /allow or deny/);
  assert.match(say(alice, "rg flag spawn fly allow"), /Unknown flag/);
  assert.match(say(alice, "rg flag nowhere build allow"), /no region called/);
  assert.match(say(alice, "rg info spawn"), /Flags: none/, "flags can be removed again");

  say(alice, "rg flag spawn deny-message &cThis is the &lspawn&r!");
  bob.sent.length = 0;
  bobCanBreak(5, Y + 1, 5);
  assert.ok(messages(bob).includes("§cThis is the §lspawn§r!"), "the message of the region is shown, with its colours");
  say(alice, "rg flag spawn deny-message");
  console.log("ok flags");

  // ---------------------------------------------------------------- priority and overlap
  stand(alice, 4, Y, 4);
  say(alice, "/pos1");
  stand(alice, 6, Y + 3, 6);
  say(alice, "/pos2");
  say(alice, "rg define shop Bob");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false, "at equal priority both regions count, and spawn still says no");
  say(alice, "rg setpriority shop 5");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "the higher priority region decides: Bob owns it");
  say(alice, "rg setpriority shop -5");
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false, "a lower priority region is ignored: Bob does not own spawn");
  say(alice, "rg setpriority shop 0");
  assert.match(say(alice, "rg setpriority shop soon"), /whole number/);
  assert.match(say(alice, "rg info shop"), /priority 0/);
  stand(alice, 5, Y + 1, 5);
  say(alice, "rg setpriority shop 1");
  assert.match(say(alice, "rg info"), /Region shop/, "without an id, the region you stand in (the one of highest priority)");
  say(alice, "rg setpriority shop 0");
  console.log("ok priority");

  // ---------------------------------------------------------------- the global region
  assert.strictEqual(bobCanBreak(50, Y + 1, 50), true);
  assert.match(say(alice, "rg flag __global__ build deny"), /now: deny/);
  assert.strictEqual(bobCanBreak(50, Y + 1, 50), false, "__global__ build deny: the whole world is read-only");
  world.setBlock(at(50, Y + 1, 50), stone);
  dig(alice, at(50, Y + 1, 50));
  assert.strictEqual(stateAt(50, Y + 1, 50), air, "operators still build");
  assert.match(say(alice, "rg addowner __global__ bob"), /no owners/);
  assert.match(say(alice, "rg flag __global__ build"), /removed/);
  assert.strictEqual(bobCanBreak(50, Y + 1, 50), true);
  console.log("ok the global region");

  // ---------------------------------------------------------------- walking in and out
  say(alice, "rg define lounge");
  assert.match(say(alice, "rg redefine lounge"), /now covers/);
  stand(alice, 100, Y, 100);
  say(alice, "/pos1");
  stand(alice, 110, Y + 5, 110);
  say(alice, "/pos2");
  say(alice, "rg redefine lounge");
  say(alice, "rg flag lounge greeting &aWelcome to the lounge");
  say(alice, "rg flag lounge farewell Bye!");
  stand(bob, 90, Y, 105);
  bob.sent.length = 0;
  walk(bob, 90.5, Y, 105.5);
  walk(bob, 105.5, Y, 105.5);
  assert.deepStrictEqual(messages(bob), ["§aWelcome to the lounge"], "a greeting when walking in");
  bob.sent.length = 0;
  walk(bob, 106.5, Y, 105.5);
  assert.deepStrictEqual(messages(bob), [], "nothing while moving inside");
  walk(bob, 95.5, Y, 105.5);
  assert.deepStrictEqual(messages(bob), ["Bye!"], "a farewell when walking out");

  say(alice, "rg flag lounge entry deny");
  bob.sent.length = 0;
  bob.player.x = 95.5;
  bob.player.y = Y;
  bob.player.z = 105.5;
  walk(bob, 96.5, Y, 105.5);
  assert.ok(Math.floor(bob.player.x) < 100, "he stands in front of it");
  walk(bob, 101.5, Y, 105.5);
  assert.ok(messages(bob).some((m) => /not allowed/.test(m)));
  assert.strictEqual(Math.floor(bob.player.x), 96, "walking into a region with entry deny puts him back where he was");
  say(alice, "rg addmember lounge bob");
  walk(bob, 101.5, Y, 105.5);
  assert.strictEqual(Math.floor(bob.player.x), 101, "members may enter");
  walk(bob, 90.5, Y, 105.5);
  say(alice, "rg removemember lounge bob");
  stand(alice, 95, Y, 105);
  walk(alice, 95.5, Y, 105.5);
  walk(alice, 105.5, Y, 105.5);
  assert.strictEqual(Math.floor(alice.player.x), 105, "operators go anywhere");
  console.log("ok greeting, farewell and entry");

  // ---------------------------------------------------------------- the rules alone
  {
    const regions = readRegions({
      regions: [
        { id: "a", min: at(0, 0, 0), max: at(9, 9, 9), priority: 0, owners: ["Ann"], members: [], flags: {} },
        { id: "b", min: at(0, 0, 0), max: at(9, 9, 9), priority: 0, owners: [], members: [], flags: { build: "allow" } },
      ],
    });
    assert.strictEqual(checkBuild(regions, "bob", at(1, 1, 1), "block-break").allowed, false, "at equal priority, one region saying no is enough (a does not know bob)");
    assert.strictEqual(checkBuild(regions, "ann", at(1, 1, 1), "block-break").allowed, true, "and both say yes to Ann (owner of a, and b allows everybody)");
    assert.strictEqual(checkBuild(regions, "bob", at(50, 1, 1), "block-break").allowed, true);
    assert.deepStrictEqual(readRegions({ regions: [{ id: "BAD ID" }, { id: "ok", min: at(0, 0, 0), max: at(1, 1, 1), priority: 0, owners: [], members: [], flags: {} }, "x", null] }).map((r) => r.id), ["ok"], "damaged entries are skipped one by one");
    assert.deepStrictEqual(readRegions("garbage"), []);
    console.log("ok the rules");
  }

  // ---------------------------------------------------------------- explosions
  {
    server.explosions.random = () => 0.5;
    const dirt = defaultState("dirt");
    for (let y = Y; y <= Y + 4; y++) for (let z = 2; z <= 8; z++) for (let x = -6; x <= 12; x++) world.setBlock(at(x, y, z), air);
    /** A block inside the spawn region and one outside it, both three blocks from the blast, in the open air. */
    const blast = (): { inside: boolean; outside: boolean } => {
      world.setBlock(at(3, Y + 1, 5), dirt);
      world.setBlock(at(-3, Y + 1, 5), dirt);
      server.explosions.explode(0.5, Y + 1.5, 5.5, 4);
      return { inside: stateAt(3, Y + 1, 5) === air, outside: stateAt(-3, Y + 1, 5) === air };
    };
    assert.deepStrictEqual(blast(), { inside: false, outside: true }, "an explosion leaves a region alone, and destroys what is outside");
    say(alice, "rg flag spawn tnt allow");
    assert.deepStrictEqual(blast(), { inside: true, outside: true }, "tnt allow: the region can be destroyed");
    say(alice, "rg flag spawn tnt deny");
    assert.deepStrictEqual(blast(), { inside: false, outside: true }, "tnt deny: protected");
    say(alice, "rg flag spawn tnt");
    say(alice, "rg flag __global__ tnt deny");
    assert.deepStrictEqual(blast(), { inside: false, outside: false }, "__global__ tnt deny protects the whole world");
    say(alice, "rg flag __global__ tnt");
    assert.deepStrictEqual(blast(), { inside: false, outside: true }, "and without it, only the regions are protected");
    console.log("ok explosions");
  }

  // ---------------------------------------------------------------- pvp
  {
    bob.player.gameMode = GameMode.Survival;
    stand(bob, 5, Y + 1, 5);
    say(alice, "rg flag spawn pvp deny");
    assert.strictEqual(bob.player.combat.damage(2, alice.player, "melee"), false, "pvp deny: players cannot hurt each other inside the region");
    assert.strictEqual(bob.player.combat.damage(2, undefined, "fall"), true, "damage that is nobody's attack still works there");
    bob.player.combat.reset();
    stand(bob, 50, Y + 1, 50);
    assert.strictEqual(bob.player.combat.damage(2, alice.player, "melee"), true, "outside the region they can");
    bob.player.combat.reset();
    stand(bob, 5, Y + 1, 5);
    say(alice, "rg flag spawn pvp");
    assert.strictEqual(bob.player.combat.damage(2, alice.player, "melee"), true, "without the flag, pvp is allowed");
    bob.player.combat.reset();
    bob.player.gameMode = GameMode.Creative;
    console.log("ok pvp");
  }

  // ---------------------------------------------------------------- it is saved
  assert.ok(fs.existsSync(path.join("plugins-data", "worldguard.json")));
  server.plugins.disable("worldguard");
  assert.match(say(alice, "rg list"), /Unknown command/);
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), true, "while the plugin is off nothing is protected");
  server.plugins.enable(worldGuardPlugin);
  assert.match(say(alice, "rg list"), /spawn.*|lounge/, "the regions are back after a restart");
  assert.match(say(alice, "rg info lounge"), /Flags: .*entry: deny/);
  assert.strictEqual(bobCanBreak(5, Y + 1, 5), false, "and protect again");
  assert.match(say(alice, "rg remove lounge"), /removed/);
  assert.match(say(alice, "rg info lounge"), /no region called/);
  console.log("ok saving");

  console.log("ALL WORLDGUARD CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("WORLDGUARD CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
