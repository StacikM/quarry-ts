/**
 * Checks the profiling commands (/tps, /mem, /perf) and moderation commands
 * (/kick, /ban, /unban, /banip, /unbanip, /banlist), from game and from the console.
 * Run with:  npx tsx scripts/admin-check.ts
 *
 * It works in a temporary folder, so it never touches your real ops.json, bans.json or world/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-admin-"));
process.chdir(workDir);

/** Runs `fn` with console output hidden. */
function quiet<T>(fn: () => T): T {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

async function main(): Promise<void> {
  fs.writeFileSync("ops.json", JSON.stringify(["Boss"])); // read when the config loads

  const { ServerStats, formatBytes } = await import("../src/game/stats");
  const { BanList } = await import("../src/game/bans");
  const { MinecraftServer } = await import("../src/game/Server");
  const { runCommand } = await import("../src/game/commands");
  const { runConsoleCommand } = await import("../src/consoleCommands");
  const { handleLogin } = await import("../src/protocol/handlers/login");
  const { handleConfiguration } = await import("../src/protocol/handlers/configuration");
  const { LoginIn, ConfigIn, PlayOut } = await import("../src/protocol/packetIds");
  const { chatText, readerFor, NO_UUID } = await import("./support/fakeClient");
  const { VERSION_NAME } = await import("../src/config");
  const { PacketReader } = await import("../src/network/PacketReader");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { ConnectionState } = await import("../src/network/ConnectionState");
  const { normalizeIp } = await import("../src/util/ip");

  // ------------------------------------------------------------------ stats
  {
    let clock = 1_000_000;
    const stats = new ServerStats(() => clock);
    assert.strictEqual(stats.tps(60), 20, "a brand new server reports a perfect 20");

    // 20 ticks per second for 70 seconds.
    for (let i = 0; i < 70 * 20; i++) {
      stats.recordTick(0.5);
      clock += 50;
    }
    assert.strictEqual(stats.tps(60), 20);
    assert.strictEqual(stats.tps(900), 20, "a young server averages over its own age, not the full 15 minutes");

    // Then 30 seconds at only 10 ticks per second.
    for (let i = 0; i < 30 * 10; i++) {
      stats.recordTick(1);
      clock += 100;
    }
    assert.ok(Math.abs(stats.tps(30) - 10) < 0.5, "half speed must read about 10, got " + stats.tps(30));
    assert.ok(stats.tps(60) > 10 && stats.tps(60) < 20, "the 1 minute average is in between");

    // The server freezes completely for 20 seconds: the number must fall without any tick being recorded.
    clock += 20_000;
    assert.ok(stats.tps(10) < 1, "a frozen server must read near 0, got " + stats.tps(10));

    // A burst of catch-up ticks can never push TPS above 20.
    const bursty = new ServerStats(() => clock);
    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < 40; i++) bursty.recordTick(0.1);
      clock += 1000;
    }
    assert.strictEqual(bursty.tps(3), 20, "TPS is capped at 20");

    // The ring buffer wraps without corrupting anything: 20 minutes of ticks, then a long gap.
    const long = new ServerStats(() => clock);
    for (let i = 0; i < 20 * 60 * 20; i++) {
      long.recordTick(0.1);
      clock += 50;
    }
    assert.strictEqual(long.tps(900), 20, "after wrapping the 15 minute average is still 20");
    clock += 5000 * 1000;
    assert.strictEqual(long.tps(60), 0, "after a very long freeze the old history is gone");

    const timing = new ServerStats(() => clock);
    for (const ms of [1, 2, 3, 10]) timing.recordTick(ms);
    assert.deepStrictEqual(timing.tickTime(), { averageMs: 4, maxMs: 10 });
    assert.deepStrictEqual(new ServerStats(() => clock).tickTime(), { averageMs: 0, maxMs: 0 });

    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(1023), "1023 B");
    assert.strictEqual(formatBytes(1536), "1.5 KB");
    assert.strictEqual(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.strictEqual(formatBytes(3 * 1024 ** 3), "3.0 GB");
    console.log("ok TPS: perfect, half speed, frozen, capped at 20, ring wraps; byte formatting");
  }

  // --------------------------------------------------------------- ban list
  {
    const file = path.join(workDir, "banlist-test.json");
    let list = new BanList(file);
    assert.strictEqual(list.banName("Griefer", "griefing", "Boss"), "banned");
    assert.strictEqual(list.banName("griefer", "again", "Boss"), "already", "names are compared ignoring capitals");
    for (const bad of ["", "two words", "x".repeat(17), "semi;colon", "../etc"]) {
      assert.strictEqual(list.banName(bad, "r", "Boss"), "invalid", `'${bad}' is not a Minecraft name`);
    }
    assert.strictEqual(list.banIp("203.0.113.5", "bots", "Console"), "banned");
    assert.strictEqual(list.banIp("::ffff:203.0.113.5", "bots", "Console"), "already", "an IPv4 address wrapped as IPv6 is the same address");
    assert.strictEqual(list.banIp("2001:db8::1", "v6", "Console"), "banned");
    assert.strictEqual(list.banIp("not an ip", "x", "Console"), "invalid");
    assert.strictEqual(list.banIp("999.1.1.1", "x", "Console"), "invalid");

    list = new BanList(file); // a fresh start must see the same bans
    assert.strictEqual(list.findNameBan("GRIEFER")?.reason, "griefing");
    assert.strictEqual(list.findNameBan("GRIEFER")?.name, "Griefer", "the name keeps the capitals it was banned with");
    assert.strictEqual(list.findIpBan("::ffff:203.0.113.5")?.reason, "bots");
    assert.strictEqual(list.findIpBan("2001:DB8::1")?.reason, "v6", "IPv6 compares ignoring capitals");
    assert.strictEqual(list.findIpBan("203.0.113.6"), undefined);
    assert.strictEqual(list.unbanName("griefer"), "unbanned");
    assert.strictEqual(list.unbanName("griefer"), "not-banned");
    assert.strictEqual(new BanList(file).findNameBan("Griefer"), undefined, "the unban must be saved");

    // A failed write must not change anything in memory.
    const realRename = fs.renameSync;
    (fs as { renameSync: unknown }).renameSync = () => {
      throw new Error("disk full");
    };
    try {
      assert.throws(() => list.banName("Mallory", "r", "Boss"), /disk full/);
      assert.throws(() => list.banIp("198.51.100.1", "r", "Boss"), /disk full/);
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }
    assert.strictEqual(list.findNameBan("Mallory"), undefined, "a failed save must not ban in memory");
    assert.strictEqual(list.findIpBan("198.51.100.1"), undefined);
    assert.strictEqual(list.listIps().length, 2);

    // Damaged file contents: set aside loudly, start with no bans.
    fs.writeFileSync(file, "{ this is not json");
    const broken = quiet(() => new BanList(file));
    assert.strictEqual(broken.listNames().length, 0);
    assert.ok(fs.existsSync(file + ".corrupt"), "a damaged ban file must be kept for inspection");
    fs.unlinkSync(file + ".corrupt");

    // A file that cannot be READ must stop the server from starting, never silently forget the bans.
    fs.writeFileSync(file, JSON.stringify({ names: [], ips: [] }));
    const realRead = fs.readFileSync;
    (fs as { readFileSync: unknown }).readFileSync = (p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith("banlist-test.json")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    };
    try {
      assert.throws(() => new BanList(file), /Refusing to start/);
    } finally {
      (fs as { readFileSync: unknown }).readFileSync = realRead;
    }
    assert.ok(fs.existsSync(file) && !fs.existsSync(file + ".corrupt"), "an unreadable file is left alone");

    // Individual bad entries are skipped, good ones kept.
    fs.writeFileSync(
      file,
      JSON.stringify({
        names: [
          { name: "Good", reason: "r", by: "b", date: "2026-01-01T00:00:00.000Z" },
          { name: "bad name!", reason: "r", by: "b", date: "d" },
          { name: "NoReason" },
          42,
        ],
        ips: [{ ip: "192.0.2.1", reason: "r", by: "b", date: "d" }, { ip: "nope", reason: "r", by: "b", date: "d" }],
      }),
    );
    const partial = quiet(() => new BanList(file));
    assert.deepStrictEqual(partial.listNames().map((b) => b.name), ["Good"]);
    assert.deepStrictEqual(partial.listIps().map((b) => b.ip), ["192.0.2.1"]);

    assert.strictEqual(normalizeIp("::FFFF:10.0.0.1"), "10.0.0.1");
    console.log("ok ban list: saved, case-insensitive, IPv6/IPv4 forms, failed write changes nothing, damaged/unreadable/partial files");
  }

  // -------------------------------------------------- server, players, login
  const server = new MinecraftServer();

  type Conn = {
    player: { username: string; gameMode: number; sendMessage(t: string, c?: string): void } | null;
    address: string;
    clientIp: string;
    protocolVersion: number;
    pending: unknown;
    compressionThreshold: number;
    velocityMessageId: number | null;
    state: number;
    server: typeof server;
    said: string[];
    kicked: string[];
    send(packet: { packetId: number; body(): Buffer }): void;
    disconnect(reason: string): void;
  };

  /** A fake client connection that records the chat it receives and the reason it was disconnected with. */
  function fakeConnection(ip: string): Conn {
    const connection: Conn = {
      player: null,
      address: ip + ":50000",
      clientIp: normalizeIp(ip),
      protocolVersion: 774,
      pending: null,
      compressionThreshold: -1,
      velocityMessageId: null,
      state: ConnectionState.Login,
      server,
      said: [],
      kicked: [],
      send(packet) {
        const text = chatText(packet);
        if (text !== null && packet.packetId === PlayOut.SystemChat) connection.said.push(text);
      },
      disconnect(reason) {
        connection.kicked.push(reason);
      },
    };
    return connection;
  }

  /** Logs in through the real login handler, exactly as a client would. */
  function login(name: string, ip: string): Conn {
    const connection = fakeConnection(ip);
    quiet(() => {
      handleLogin(connection as never, LoginIn.LoginStart, readerFor(new PacketWriter(0).writeString(name).writeUUID(NO_UUID)));
      if (!connection.pending) return; // turned away
      handleLogin(connection as never, LoginIn.LoginAcknowledged, readerFor(new PacketWriter(0)));
      const packs = new PacketWriter(0).writeVarInt(1).writeString("minecraft").writeString("core").writeString(VERSION_NAME);
      handleConfiguration(connection as never, ConfigIn.KnownPacks, readerFor(packs));
      handleConfiguration(connection as never, ConfigIn.FinishConfiguration, readerFor(new PacketWriter(0)));
    });
    connection.said.length = 0; // forget the welcome messages
    return connection;
  }

  const boss = login("Boss", "10.0.0.1");
  const alice = login("Alice", "10.0.0.2");
  const bob = login("Bob", "10.0.0.3");
  assert.ok(boss.player && alice.player && bob.player, "all three logged in");
  const send = (who: Conn, command: string): void => quiet(() => runCommand(who.player as never, command));
  const consoleSays = (line: string): string => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      runConsoleCommand(server, line);
    } finally {
      console.log = log;
    }
    return lines.join("\n");
  };
  const consoleWarns = (line: string): string => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      runConsoleCommand(server, line);
    } finally {
      console.warn = warn;
    }
    return lines.join("\n");
  };

  // ------------------------------------------------------------ permissions
  {
    for (const command of ["kick Bob", "ban Bob", "unban Bob", "banip Bob", "unbanip 1.2.3.4", "banlist", "mem", "perf", "say hi", "save"]) {
      alice.said.length = 0;
      send(alice, command);
      assert.ok(alice.said.some((m) => /permission/i.test(m)), `a normal player must be refused /${command}`);
    }
    assert.strictEqual(bob.kicked.length, 0, "and nobody was kicked");
    alice.said.length = 0;
    send(alice, "tps");
    assert.ok(alice.said.join("\n").includes("TPS (1m, 5m, 15m)"), "/tps is public");
    console.log("ok permissions: moderation, /mem and /perf need operator, /tps is public");
  }

  // -------------------------------------------------------------- profiling
  {
    boss.said.length = 0;
    send(boss, "mem");
    const mem = boss.said.join("\n");
    for (const part of ["Whole process", "JavaScript heap", "Buffers", "World in memory", "limit"]) assert.ok(mem.includes(part), `/mem shows "${part}"`);
    assert.ok(/\d+(\.\d)? (KB|MB|GB)/.test(mem), "/mem shows sizes");

    boss.said.length = 0;
    send(boss, "perf");
    const perf = boss.said.join("\n");
    for (const part of ["Quarry.ts performance", "player(s)", "CPU", "TPS", "Memory", "Chunks generated", "Chunks lit"]) {
      assert.ok(perf.includes(part), `/perf shows "${part}"`);
    }

    // The memory estimate grows when chunks are loaded and lit.
    const before = server.world.memoryReport();
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) server.world.getLight(server.world.getChunk(cx + 50, cz + 50));
    const after = server.world.memoryReport();
    assert.ok(after.chunks > before.chunks, "more chunks loaded");
    assert.ok(after.blockBytes > before.blockBytes && after.lightBytes > before.lightBytes, "the estimate grows with chunks and light");
    assert.ok(server.world.timings.chunksGenerated >= 16 && server.world.timings.chunksLit >= 16, "chunk work is counted");

    // The console gets the same output, without colour codes.
    const fromConsole = consoleSays("tps");
    assert.ok(fromConsole.includes("TPS (1m, 5m, 15m)"), "the console can run /tps");
    assert.ok(!fromConsole.includes("§"), "colour codes must not reach the terminal");
    assert.ok(consoleSays("mem").includes("Whole process"), "the console can run /mem");
    assert.ok(consoleSays("/perf").includes("Quarry.ts performance"), "a leading slash is allowed in the console");
    console.log("ok /tps, /mem, /perf work in game and in the console; memory estimate grows with chunks");
  }

  // ----------------------------------------------------------------- kick
  {
    boss.said.length = 0;
    send(boss, "kick Ghost");
    assert.ok(boss.said.some((m) => /not online/.test(m)), "kicking someone who is not online is explained");
    send(boss, "kick");
    assert.ok(boss.said.some((m) => /Usage/.test(m)));

    alice.said.length = 0;
    send(boss, "kick ALICE being rude");
    assert.strictEqual(alice.kicked.length, 1, "the target is disconnected");
    assert.ok(alice.kicked[0].includes("being rude"), "and sees the reason");
    assert.ok(bob.said.some((m) => /Alice was kicked by Boss: being rude/.test(m)), "everyone is told");

    // The kicked player's connection stays in the server's list until the socket closes, so close it like a real one would.
    quiet(() => server.onConnectionClosed(alice as never));

    // Reasons are cleaned, a missing reason gets a default.
    const carol = login("Carol", "10.0.0.4");
    send(boss, "kick Carol §cFAKE\u0000 " + "x".repeat(300));
    assert.ok(!carol.kicked[0].includes("§") && !carol.kicked[0].includes("\u0000"), "colour and control characters are removed from reasons");
    assert.ok(carol.kicked[0].length < 160, "and long reasons are cut");
    quiet(() => server.onConnectionClosed(carol as never));
    const dave = login("Dave", "10.0.0.5");
    send(boss, "kick Dave");
    assert.ok(/Kicked by an operator/.test(dave.kicked[0]), "a default reason is used");
    quiet(() => server.onConnectionClosed(dave as never));

    // Operators cannot be kicked from in game, but the console can.
    const second = login("Second", "10.0.0.6");
    quiet(() => runConsoleCommand(server, "op Second"));
    second.said.length = 0;
    send(boss, "kick Second");
    assert.strictEqual(second.kicked.length, 0, "an operator cannot kick another operator");
    assert.ok(boss.said.some((m) => /can't kick an operator/.test(m)));
    quiet(() => runConsoleCommand(server, "kick Second"));
    assert.strictEqual(second.kicked.length, 1, "the console can kick an operator");
    quiet(() => server.onConnectionClosed(second as never));
    quiet(() => runConsoleCommand(server, "deop Second"));
    console.log("ok /kick: reason, broadcast, cleaned reasons, operators protected from other operators but not from the console");
  }

  // ------------------------------------------------------------------ bans
  {
    // Ban a player who is online: they are kicked with the reason, and it is saved.
    boss.said.length = 0;
    send(boss, "ban bob griefing the spawn");
    assert.strictEqual(bob.kicked.length, 1, "an online player is kicked when banned");
    assert.ok(bob.kicked[0].includes("banned") && bob.kicked[0].includes("griefing the spawn"));
    assert.strictEqual(server.bans.findNameBan("BOB")?.by, "Boss", "the ban records who did it");
    assert.ok(JSON.parse(fs.readFileSync("bans.json", "utf8")).names.some((b: { name: string }) => b.name === "bob"), "and is written to bans.json");
    assert.ok(boss.said.some((m) => /banip/.test(m)), "the operator is reminded that names are easy to change");
    quiet(() => server.onConnectionClosed(bob as never));

    // The banned player is turned away at login, in any capitalisation, from any address.
    for (const name of ["bob", "BOB", "Bob"]) {
      const attempt = login(name, "10.9.9.9");
      assert.strictEqual(attempt.player, null, `${name} must not get in`);
      assert.ok(attempt.kicked[0].includes("You are banned") && attempt.kicked[0].includes("griefing the spawn"), "and is told why");
    }
    assert.ok(!server.getPlayerByName("bob"), "a refused player never appears in the player list");

    // Already banned, bad names, operators, offline players.
    boss.said.length = 0;
    send(boss, "ban bob");
    assert.ok(boss.said.some((m) => /already banned/.test(m)));
    send(boss, "ban not*valid");
    assert.ok(boss.said.some((m) => /Usage/.test(m)));
    send(boss, "ban Boss");
    assert.ok(boss.said.some((m) => /can't ban an operator/.test(m)), "operators cannot ban operators in game");
    assert.strictEqual(server.bans.findNameBan("Boss"), undefined);
    send(boss, "ban Offline Player who never joined");
    assert.ok(server.bans.findNameBan("Offline"), "players who are not online can be banned by name");

    // Unban (and its alias) lets them back in.
    send(boss, "unban BOB");
    const back = login("Bob", "10.0.0.3");
    assert.ok(back.player, "after /unban the player can join again");
    quiet(() => server.onConnectionClosed(back as never));
    send(boss, "pardon offline");
    assert.strictEqual(server.bans.findNameBan("Offline"), undefined, "/pardon works like /unban");
    boss.said.length = 0;
    send(boss, "unban nobody");
    assert.ok(boss.said.some((m) => /not banned/.test(m)));

    // The console can ban too, and can ban operators.
    quiet(() => runConsoleCommand(server, "ban Boss testing"));
    assert.ok(server.bans.findNameBan("Boss"), "the console can ban an operator");
    assert.strictEqual(boss.kicked.length, 1, "and the operator is kicked");
    quiet(() => server.onConnectionClosed(boss as never));
    quiet(() => runConsoleCommand(server, "unban Boss"));
    console.log("ok /ban, /unban, /pardon: kicks and saves, refused at login in any capitals, operators protected, console can ban");
  }

  // ----------------------------------------------------------------- IP bans
  {
    const boss2 = login("Boss", "10.0.0.1");
    const eve = login("Eve", "10.0.0.50");
    const eve2 = login("Eve2", "10.0.0.50"); // same address
    const frank = login("Frank", "::ffff:10.0.0.60"); // IPv4 wrapped as IPv6, as many systems report it
    assert.ok(boss2.player && eve.player && eve2.player && frank.player);

    boss2.said.length = 0;
    send(boss2, "banip Eve using alts");
    assert.strictEqual(eve.kicked.length + eve2.kicked.length, 2, "everyone on that address is kicked");
    assert.ok(eve.kicked[0].includes("using alts"));
    assert.ok(boss2.said.some((m) => /Banned 10\.0\.0\.50\. 2 online/.test(m)), "and the operator is told how many");
    quiet(() => server.onConnectionClosed(eve as never));
    quiet(() => server.onConnectionClosed(eve2 as never));

    const rejoin = login("Brandnew", "10.0.0.50");
    assert.strictEqual(rejoin.player, null, "a new name from a banned address is refused");
    assert.ok(rejoin.kicked[0].includes("using alts"));

    // IPv4 wrapped as IPv6 is recognised in both directions.
    send(boss2, "banip 10.0.0.60");
    assert.strictEqual(frank.kicked.length, 1, "banning 10.0.0.60 catches ::ffff:10.0.0.60");
    quiet(() => server.onConnectionClosed(frank as never));
    assert.strictEqual(login("Another", "::ffff:10.0.0.60").player, null);

    // Mistakes.
    boss2.said.length = 0;
    send(boss2, "banip");
    send(boss2, "banip Nobody");
    send(boss2, "banip 10.0.0.50");
    assert.ok(boss2.said.filter((m) => /Usage|Give an IP|already banned/.test(m)).length === 3, "usage, unknown player and already-banned are each reported");
    send(boss2, "banip Boss");
    assert.ok(boss2.said.some((m) => /belongs to an operator/.test(m)), "an operator cannot ban their own address from in game");
    assert.strictEqual(server.bans.findIpBan("10.0.0.1"), undefined);

    // Unban.
    send(boss2, "unbanip 10.0.0.50");
    assert.ok(login("Eve", "10.0.0.50").player, "after /unbanip the address can join again");
    boss2.said.length = 0;
    send(boss2, "unbanip not-an-ip");
    assert.ok(boss2.said.some((m) => /Usage/.test(m)));

    // The console warns before locking out this computer.
    const warned = consoleSays("banip 127.0.0.1 test");
    assert.ok(/this computer/.test(warned), "banning 127.0.0.1 warns that it blocks the machine itself");
    quiet(() => runConsoleCommand(server, "unbanip 127.0.0.1"));

    // banlist shows names and addresses, with who and when.
    quiet(() => runConsoleCommand(server, "ban Listed being listed"));
    const listing = consoleSays("banlist");
    assert.ok(/Banned names \(\d+\)/.test(listing) && /Listed: being listed \(by Console, \d{4}-\d\d-\d\d\)/.test(listing));
    assert.ok(/Banned addresses \(\d+\)/.test(listing) && listing.includes("10.0.0.60"));
    send(boss2, "banlist");
    assert.ok(boss2.said.join("\n").includes("Banned names"), "operators can read the list in game");
    quiet(() => server.onConnectionClosed(boss2 as never)); // so "Boss" can log in again below
    console.log("ok /banip, /unbanip, /banlist: whole address kicked, IPv4-as-IPv6 matched, new names from a banned address refused");
  }

  // ------------------------------------------- a failing disk changes nothing
  {
    const boss3 = login("Boss", "10.0.0.1");
    const grace = login("Grace", "10.0.0.70");
    const realRename = fs.renameSync;
    (fs as { renameSync: unknown }).renameSync = () => {
      throw new Error("disk full");
    };
    try {
      boss3.said.length = 0;
      send(boss3, "ban Grace");
      send(boss3, "banip Grace");
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }
    assert.strictEqual(grace.kicked.length, 0, "if the ban cannot be saved, nobody is kicked");
    assert.strictEqual(server.bans.findNameBan("Grace"), undefined);
    assert.strictEqual(server.bans.findIpBan("10.0.0.70"), undefined);
    assert.ok(boss3.said.filter((m) => /Could not save bans\.json/.test(m)).length === 2, "and the operator is told why");
    console.log("ok a failing disk: the ban is not applied, nobody is kicked, the operator is told");
  }

  // ------------------------------------------------------------- the console
  {
    assert.ok(/can only be used in game/.test(consoleWarns("tp Boss")), "game-only commands explain themselves in the console");
    assert.ok(/Unknown command/.test(consoleWarns("tpz")));
    const help = consoleSays("help");
    for (const wanted of ["kick", "ban", "unban", "banip", "banlist", "tps", "mem", "perf", "say", "stop force"]) {
      assert.ok(help.includes(wanted), `console help lists ${wanted}`);
    }
    assert.ok(!/^\[.*\] tp /m.test(help) && !/\btp\b - /.test(help), "console help hides game-only commands");
    console.log("ok console: shared commands, game-only ones explained, help lists the right things");
  }

  console.log("ALL ADMIN CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("ADMIN CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`(could not delete the temporary folder ${workDir}; it is safe to delete by hand)`);
    }
    process.exit(process.exitCode ?? 0); // the server object has timers we never started, but be sure
  });
