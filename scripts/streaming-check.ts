/**
 * Checks how chunks are sent to players: only the nearest few at once, the rest
 * streamed a few per tick, nearest first.
 * Run with:  npx tsx scripts/streaming-check.ts
 *
 * Why this matters: generating, lighting and sending 169 chunks in one go froze the
 * whole server for about 330 ms (and gave the client an 11 MB burst) on every far
 * teleport. It works in a temporary folder, so it never touches your real world.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-stream-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { config } = await import("../src/config");
  const { decodeVarInt } = await import("../src/network/VarInt");
  const { PlayOut } = await import("../src/protocol/packetIds");
  const { pendingLogin } = await import("./support/fakeClient");

  type Event = { kind: "chunk" | "unload" | "position"; x?: number; z?: number };
  type Fake = {
    player: any;
    address: string;
    clientIp: string;
    events: Event[];
    send(packet: { packetId: number; body(): Buffer }): void;
    disconnect(reason: string): void;
  };

  const server = new MinecraftServer();
  const quiet = <T>(fn: () => T): T => {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      return fn();
    } finally {
      Object.assign(console, saved);
    }
  };

  /** A fake client that records which chunks it was sent, in order. */
  function join(name: string, uuidEnd: string): Fake {
    const fake: Fake = {
      player: null,
      address: "test",
      clientIp: "10.0.0." + uuidEnd,
      events: [],
      send(packet) {
        if (packet.packetId === PlayOut.PlayerPosition) fake.events.push({ kind: "position" });
        const body = packet.body().subarray(1); // skip the packet id (all ids used here fit in one byte)
        if (packet.packetId === PlayOut.ChunkDataAndLight) fake.events.push({ kind: "chunk", x: body.readInt32BE(0), z: body.readInt32BE(4) });
        // (an Unload Chunk packet lists z first, then x)
        if (packet.packetId === PlayOut.UnloadChunk) fake.events.push({ kind: "unload", x: body.readInt32BE(4), z: body.readInt32BE(0) });
      },
      disconnect() {},
    };
    quiet(() => server.addPlayer(fake as never, pendingLogin(name, "00000000-0000-0000-0000-00000000000" + uuidEnd)));
    return fake;
  }

  const chunksOf = (events: Event[]): Event[] => events.filter((e) => e.kind === "chunk");
  const key = (e: Event): string => `${e.x},${e.z}`;
  const radius = config.viewDistance;
  const urgent = config.urgentChunkRadius;
  const area = (2 * radius + 1) ** 2;
  const urgentCount = (2 * urgent + 1) ** 2;
  const wantedAround = (cx: number, cz: number): Set<string> => {
    const keys = new Set<string>();
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) keys.add(`${cx + dx},${cz + dz}`);
    return keys;
  };
  const drain = (): number => {
    let calls = 0;
    while (server.getPendingChunkCount() > 0) {
      server.streamChunks();
      assert.ok(++calls < 10_000, "streaming never finished");
    }
    return calls;
  };

  // ------------------------------------------------------------------ joining
  const alice = join("Alice", "1");
  {
    const positionAt = alice.events.findIndex((e) => e.kind === "position");
    assert.ok(positionAt >= 0, "the player was positioned");
    assert.strictEqual(chunksOf(alice.events.slice(0, positionAt)).length, 0, "the position comes first, then the chunks");
    assert.strictEqual(chunksOf(alice.events.slice(positionAt)).length, urgentCount, "only the chunks right around the player are sent at once");
    assert.strictEqual(chunksOf(alice.events).length, urgentCount, "and nothing more has been sent yet");
    assert.strictEqual(alice.player.pendingChunkCount, area - urgentCount, "the rest are waiting in the queue");

    const calls = drain();
    const all = chunksOf(alice.events);
    assert.strictEqual(all.length, area, "everyone in view distance is eventually sent");
    assert.strictEqual(new Set(all.map(key)).size, area, "and no chunk is sent twice");
    assert.deepStrictEqual(new Set(all.map(key)), wantedAround(0, 0), "exactly the chunks around the player");
    const distances = all.map((e) => Math.hypot(e.x!, e.z!));
    assert.ok(distances.slice(urgentCount).every((d, i, arr) => i === 0 || d >= arr[i - 1] - 1e-9), "streamed chunks go nearest first");
    assert.ok(calls > 3, "it took several ticks, not one");
    console.log(`ok joining: ${urgentCount} chunks at once, the other ${area - urgentCount} over ${calls} ticks, nearest first, none twice`);
  }

  // ----------------------------------------------------------------- teleport
  {
    alice.events.length = 0;
    quiet(() => alice.player.teleport(8000.5, 80, 8000.5)); // 500 chunks away, nothing there yet
    const positionAt = alice.events.findIndex((e) => e.kind === "position");
    const sentNow = chunksOf(alice.events);
    assert.strictEqual(sentNow.length, urgentCount, "a far teleport sends only the chunks around the destination immediately");
    assert.ok(alice.events.slice(0, positionAt).filter((e) => e.kind === "chunk").length === urgentCount, "and they arrive BEFORE the position, so the player has ground");
    assert.strictEqual(alice.events.filter((e) => e.kind === "unload").length, area, "the old area is dropped at once (cheap)");
    assert.strictEqual(alice.player.pendingChunkCount, area - urgentCount);

    drain();
    const loaded = alice.player.loadedChunkKeys as ReadonlySet<string>;
    assert.deepStrictEqual(new Set(loaded), wantedAround(500, 500), "afterwards the client has exactly the new area");
    console.log("ok teleport: 9 chunks before the position, old area dropped, new area streamed in");
  }

  // ------------------------------------------------- teleporting again mid-stream
  {
    quiet(() => alice.player.teleport(0.5, 80, 0.5));
    for (let i = 0; i < 3; i++) server.streamChunks(); // part of the way there...
    alice.events.length = 0;
    quiet(() => alice.player.teleport(-8000.5, 80, 8000.5)); // ...then somewhere else entirely
    drain();
    const wanted = wantedAround(Math.floor(-8000.5 / 16), Math.floor(8000.5 / 16)); // chunk numbers round down, so x = -8000.5 is chunk -501
    for (const event of chunksOf(alice.events)) assert.ok(wanted.has(key(event)), `chunk ${key(event)} from the abandoned trip was still sent`);
    assert.deepStrictEqual(new Set(alice.player.loadedChunkKeys), wanted, "the client ends up with exactly the latest destination");
    assert.strictEqual(alice.player.pendingChunkCount, 0);
    console.log("ok teleporting again mid-stream abandons the old trip and loads only the new destination");
  }

  // ------------------------------------------------------------------ walking
  {
    quiet(() => alice.player.teleport(0.5, 80, 0.5));
    drain();
    alice.events.length = 0;
    alice.player.x += 16; // walk one chunk east
    alice.player.updateLoadedChunks();
    assert.strictEqual(chunksOf(alice.events).length, 0, "walking into a new chunk sends nothing immediately");
    assert.strictEqual(alice.player.pendingChunkCount, 2 * radius + 1, "the new column of chunks is queued");
    assert.strictEqual(alice.events.filter((e) => e.kind === "unload").length, 2 * radius + 1, "and the old column is dropped");
    drain();
    assert.deepStrictEqual(new Set(alice.player.loadedChunkKeys), wantedAround(1, 0));
    console.log("ok walking: the new column is streamed, not sent in one lump");
  }

  // ------------------------------------------------ budget, progress, fairness
  {
    const bob = join("Bob", "2");
    quiet(() => alice.player.teleport(4000.5, 80, 4000.5));
    quiet(() => bob.player.teleport(-4000.5, 80, -4000.5));
    const aliceWaiting = alice.player.pendingChunkCount;
    const bobWaiting = bob.player.pendingChunkCount;
    assert.ok(aliceWaiting > 100 && bobWaiting > 100);

    assert.strictEqual(server.streamChunks(0), 1, "even with no time budget at least one chunk is sent, so loading can't stall");
    assert.strictEqual(server.streamChunks(0), 1);
    assert.strictEqual(
      aliceWaiting - alice.player.pendingChunkCount + (bobWaiting - bob.player.pendingChunkCount),
      2,
      "those two chunks went out",
    );
    assert.strictEqual(aliceWaiting - alice.player.pendingChunkCount, 1, "players take turns: Alice got one...");
    assert.strictEqual(bobWaiting - bob.player.pendingChunkCount, 1, "...and Bob got one");

    // While both are waiting, nobody gets far ahead of the other.
    for (let i = 0; i < 20; i++) {
      server.streamChunks(0);
      const gap = Math.abs(alice.player.pendingChunkCount - bob.player.pendingChunkCount - (aliceWaiting - bobWaiting));
      assert.ok(gap <= 1, "chunks are shared fairly, gap " + gap);
    }

    const total = server.getPendingChunkCount();
    assert.strictEqual(server.streamChunks(1e9), total, "a huge budget sends everything in one go");
    assert.strictEqual(server.getPendingChunkCount(), 0);
    quiet(() => server.onConnectionClosed(bob as never));
    console.log("ok budget: at least one chunk per call, a huge budget finishes everything, players take turns");
  }

  // --------------------------------------------------------------- a failing chunk
  {
    quiet(() => alice.player.teleport(0.5, 80, 0.5));
    drain();
    alice.events.length = 0;

    const realGetChunk = server.world.getChunk.bind(server.world);
    const broken = "7,0"; // a chunk on the new edge, for example one whose save file cannot be read
    server.world.getChunk = (x: number, z: number) => {
      if (`${x},${z}` === broken) throw new Error("save file unreadable");
      return realGetChunk(x, z);
    };
    try {
      alice.player.x += 16;
      alice.player.updateLoadedChunks();
      assert.doesNotThrow(() => quiet(() => drain()), "one bad chunk must not crash the tick");
    } finally {
      server.world.getChunk = realGetChunk;
    }
    const sentKeys = new Set(chunksOf(alice.events).map(key));
    assert.ok(!sentKeys.has(broken), "the broken chunk was not sent");
    assert.ok(sentKeys.size === 2 * radius, "every other new chunk was");
    assert.strictEqual(alice.player.pendingChunkCount, 0, "and it is not retried in a loop every tick");

    // It is tried again once the player moves on and the problem is gone.
    alice.player.x += 16;
    alice.player.updateLoadedChunks();
    drain();
    assert.ok((alice.player.loadedChunkKeys as ReadonlySet<string>).has("7,0") || !wantedAround(2, 0).has("7,0"), "a skipped chunk comes back when still needed");
    console.log("ok a chunk that fails to load is skipped, logged, not retried in a loop, and does not crash anything");
  }

  // ------------------------------------------------------- tick and disconnect
  {
    quiet(() => alice.player.teleport(-2000.5, 80, 2000.5));
    const before = alice.player.pendingChunkCount;
    (server as unknown as { tick(): void }).tick();
    assert.ok(alice.player.pendingChunkCount < before, "each server tick sends some of the waiting chunks");

    quiet(() => server.onConnectionClosed(alice as never));
    assert.strictEqual(server.streamChunks(), 0, "nothing is sent for a player who has left");

    const perf = (() => {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => lines.push(args.join(" "));
      try {
        server.plugins.commands.get("perf")!.runConsole!(server.console, []);
      } finally {
        console.log = log;
      }
      return lines.join("\n");
    })();
    assert.ok(/Chunks waiting to be sent to players: \d+/.test(perf), "/perf shows how many chunks are queued");
    console.log("ok each tick streams some chunks, a disconnected player is forgotten, /perf shows the queue");
  }

  // ----------------------------------------------------------- spread-out autosave
  {
    const block = (i: number) => ({ x: 100_000 + i * 16 + 3, y: 90, z: 100_000 + 3 }); // one block in each of many chunks
    const dirtyFiles = (): number => fs.readdirSync(path.join(workDir, "world", "1.21.11", fs.readdirSync(path.join(workDir, "world", "1.21.11"))[0])).filter((n) => n.endsWith(".edits")).length;
    const before = fs.existsSync(path.join(workDir, "world", "1.21.11")) ? dirtyFiles() : 0;

    for (let i = 0; i < 30; i++) server.world.setBlock(block(i), 1);
    server.startAutosave();

    let steps = 0;
    let lastRemaining = Infinity;
    while ((server as unknown as { autosave: unknown }).autosave) {
      server.stepAutosave(0); // no time budget: must still make progress, one chunk per step
      assert.ok(++steps < 1000, "the autosave never finished");
      const filesNow = dirtyFiles() - before;
      assert.ok(filesNow >= Math.min(steps, 30), "every step writes at least one chunk (step " + steps + ", files " + filesNow + ")");
      assert.ok(30 - filesNow <= lastRemaining, "the number of unsaved chunks never goes up");
      lastRemaining = 30 - filesNow;
    }
    assert.ok(steps >= 25, "a zero budget spreads 30 chunks over many steps, got " + steps);
    assert.strictEqual(dirtyFiles() - before, 30, "all 30 changed chunks are on disk at the end");
    assert.strictEqual(server.world.saveDirtyChunks().saved, 0, "and nothing is left unsaved");

    // A chunk that cannot be saved is skipped for this autosave (not retried every tick), and the rest are written.
    for (let i = 0; i < 6; i++) server.world.setBlock(block(100 + i), 1);
    const storage = (server.world as unknown as { storage: { save(x: number, z: number, e: unknown): void } }).storage;
    const realSave = storage.save.bind(storage);
    let attemptsOnBadChunk = 0;
    storage.save = (x, z, edits) => {
      if (x === Math.floor(block(102).x / 16)) {
        attemptsOnBadChunk++;
        throw new Error("disk says no");
      }
      realSave(x, z, edits);
    };
    try {
      server.startAutosave();
      for (let i = 0; i < 50 && (server as unknown as { autosave: unknown }).autosave; i++) quiet(() => server.stepAutosave(0));
      assert.ok(!(server as unknown as { autosave: unknown }).autosave, "an autosave with one failing chunk still finishes");
      assert.strictEqual(attemptsOnBadChunk, 1, "the failing chunk is tried once per autosave, not every tick");
    } finally {
      storage.save = realSave;
    }
    assert.strictEqual(server.world.saveDirtyChunks().saved, 1, "the chunk that failed is still marked changed and saved by the next save");

    // A manual save (or shutdown) in the middle of an autosave finishes everything at once and ends the slow autosave.
    for (let i = 0; i < 10; i++) server.world.setBlock(block(200 + i), 1);
    server.startAutosave();
    server.stepAutosave(0);
    const result = quiet(() => server.saveWorld());
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(server.world.saveDirtyChunks().saved, 0, "saveWorld wrote everything that was left");
    assert.ok(!(server as unknown as { autosave: unknown }).autosave, "and the slow autosave is cancelled");

    // The tick does the stepping, so autosaving needs no extra timer.
    for (let i = 0; i < 4; i++) server.world.setBlock(block(300 + i), 1);
    server.startAutosave();
    for (let i = 0; i < 400 && (server as unknown as { autosave: unknown }).autosave; i++) quiet(() => (server as unknown as { tick(): void }).tick());
    assert.ok(!(server as unknown as { autosave: unknown }).autosave, "ticks alone finish an autosave");
    assert.strictEqual(server.world.saveDirtyChunks().saved, 0);
    console.log("ok autosave: spread over ticks, always progresses, a failing chunk is skipped once, a manual save finishes it, ticks drive it");
  }

  console.log("ALL STREAMING CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("STREAMING CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`(could not delete the temporary folder ${workDir}; it is safe to delete by hand)`);
    }
    process.exit(process.exitCode ?? 0);
  });
