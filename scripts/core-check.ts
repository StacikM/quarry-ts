/**
 * Regression checks for the plugin runtime and for world saving.
 * Run with:  npx tsx scripts/core-check.ts
 *
 * It works inside a temporary folder, so it never touches your real
 * world/ or plugins-data/ folders.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-check-"));
process.chdir(workDir); // plugins-data/ is resolved from the current folder when PluginManager loads

/** Runs `fn` with console output hidden, for code that is supposed to log errors. */
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
  const { Scheduler } = await import("../src/plugins/Scheduler");
  const { EventBus } = await import("../src/plugins/EventBus");
  const { PluginManager } = await import("../src/plugins/PluginManager");
  const { coreCommands } = await import("../src/game/commands");
  const { World } = await import("../src/world/World");
  const { WorldStorage, decodeEdits } = await import("../src/world/WorldStorage");
  const { createNaturalGenerator } = await import("../src/world/terrain");
  const { Block } = await import("../src/world/blocks");

  // ------------------------------------------------------------ scheduler
  {
    const s = new Scheduler();
    let runs = 0;
    s.runRepeating("p", 1, () => {
      runs++;
      s.removeAll("p"); // the task cancels its own plugin
    });
    for (let i = 0; i < 5; i++) s.tick();
    assert.strictEqual(runs, 1, "a repeating task that cancels itself must not run again");

    const s2 = new Scheduler();
    let ran = 0;
    s2.runLater("a", 1, () => s2.removeAll("b"));
    s2.runLater("b", 1, () => ran++);
    s2.tick();
    assert.strictEqual(ran, 0, "a task cancelled by an earlier task in the same batch must not run");
    console.log("ok scheduler cancellation");
  }

  // ------------------------------------------- errors that are not Errors
  {
    const bus = new EventBus();
    let after = 0;
    bus.on("x", "playerJoin", () => {
      throw null;
    });
    bus.on("x", "playerJoin", () => {
      throw undefined;
    });
    bus.on("x", "playerJoin", () => {
      throw "just a string";
    });
    bus.on("y", "playerJoin", () => {
      after++;
    });
    quiet(() => bus.emit("playerJoin", {} as never));
    assert.strictEqual(after, 1, "a later handler must still run after others threw odd values");

    const s = new Scheduler();
    let ran = 0;
    s.runLater("p", 1, () => {
      throw null;
    });
    s.runLater("p", 1, () => ran++);
    quiet(() => s.tick());
    assert.strictEqual(ran, 1);
    console.log("ok throwing null / undefined / strings");
  }

  // ------------------------------------------------------ plugin manager
  {
    const pm = new PluginManager({} as never);
    for (const c of coreCommands) pm.commands.register("core", c);

    quiet(() => {
      pm.enable({
        name: "core",
        version: "1",
        onEnable() {
          throw new Error("boom");
        },
      });
      pm.enable({ name: "CORE", version: "1", onEnable() {} });
      pm.enable({ name: "../evil", version: "1", onEnable() {} });
      pm.enable({ name: "", version: "1", onEnable() {} });
    });
    assert.ok(pm.commands.get("help"), "a plugin named core must not be able to remove /help");
    assert.deepStrictEqual(pm.getEnabledNames(), []);

    pm.enable({ name: "a", version: "1", onEnable() {} });
    pm.enable({ name: "a_b", version: "1", onEnable() {} });
    assert.deepStrictEqual(pm.getEnabledNames(), ["a", "a_b"]);

    let registered: boolean | undefined;
    quiet(() =>
      pm.enable({
        name: "dup",
        version: "1",
        onEnable(api) {
          registered = api.registerCommand({ name: "help", description: "x", run() {} });
        },
      }),
    );
    assert.strictEqual(registered, false, "registering an existing command name must report failure");

    pm.enable({
      name: "data",
      version: "1",
      onEnable(api) {
        api.saveData({ homes: 5 });
        const hasHomesObject = (v: unknown): v is { homes: object } =>
          typeof v === "object" && v !== null && typeof (v as { homes: unknown }).homes === "object";
        assert.deepStrictEqual(quiet(() => api.loadData({ homes: {} }, hasHomesObject)), { homes: {} });
        assert.deepStrictEqual(api.loadData({ homes: {} }), { homes: 5 });
      },
    });
    assert.ok(!fs.readdirSync("plugins-data").some((f) => f.endsWith(".tmp")), "saveData left a temp file behind");
    console.log("ok plugin names, command conflicts, loadData validation, atomic saveData");
  }

  // ------------------------------------------------------- world saving
  {
    const saveDir = path.join(workDir, "world-save");
    const makeWorld = () => new World(createNaturalGenerator(1337), new WorldStorage(saveDir));
    const at = (x: number, y: number, z: number) => ({ x, y, z });

    const w = makeWorld();
    const generated = w.getBlockId(at(-37, 70, 123));
    w.setBlock(at(-37, 70, 123), 35, 14); // red wool, negative x
    w.setBlock(at(5, 100, 5), Block.Stone);
    w.setBlock(at(5, 100, 5), Block.Air); // edited twice: the last one wins
    assert.deepStrictEqual(w.saveDirtyChunks(), { saved: 2, failed: 0 });
    assert.deepStrictEqual(w.saveDirtyChunks(), { saved: 0, failed: 0 }, "unchanged chunks must not be rewritten");

    const reloaded = makeWorld();
    assert.strictEqual(reloaded.getBlockId(at(-37, 70, 123)), 35);
    assert.strictEqual(reloaded.getBlockMetadata(at(-37, 70, 123)), 14);
    assert.strictEqual(reloaded.getBlockId(at(5, 100, 5)), Block.Air);
    assert.deepStrictEqual(reloaded.saveDirtyChunks(), { saved: 0, failed: 0 }, "loading edits must not mark the chunk as changed");
    assert.notStrictEqual(generated, 35);

    reloaded.setBlock(at(200, 70, 200), Block.Stone);
    reloaded.unloadChunksExcept(new Set());
    assert.ok(reloaded.loadedChunkCount >= 1, "a chunk with unsaved changes must not be unloaded");
    assert.deepStrictEqual(reloaded.saveDirtyChunks(), { saved: 1, failed: 0 });
    reloaded.unloadChunksExcept(new Set());
    assert.strictEqual(reloaded.loadedChunkCount, 0);
    assert.strictEqual(reloaded.getBlockId(at(200, 70, 200)), Block.Stone, "edit lost after unload and reload");
    console.log("ok saving, loading, unloading");

    // Damaged files must never crash the server or load as garbage.
    const file = path.join(saveDir, "-3.7.edits");
    const good = fs.readFileSync(file);
    const header = good.subarray(0, 5);
    const damaged: Record<string, Buffer> = {
      truncated: good.subarray(0, good.length - 3),
      "wrong magic": Buffer.concat([Buffer.from("XXXX"), good.subarray(4)]),
      "future version": Buffer.concat([good.subarray(0, 4), Buffer.from([99]), good.subarray(5)]),
      "flipped byte": Buffer.from(good.map((b, i) => (i === good.length - 6 ? b ^ 0xff : b))),
      empty: Buffer.alloc(0),
      garbage: Buffer.from("hello world, definitely not a chunk"),
      "entry count too big": Buffer.concat([header, zlib.deflateSync(Buffer.from([255, 255, 255, 127]))]),
      "block id too big": Buffer.concat([header, zlib.deflateSync(Buffer.from([1, 0, 0, 0, 1, 0, 0xff, 0xff]))]),
    };
    for (const [name, bytes] of Object.entries(damaged)) {
      assert.throws(() => decodeEdits(bytes), undefined, `${name} was accepted`);
      fs.writeFileSync(file, bytes);
      const id = quiet(() => makeWorld().getBlockId(at(-37, 70, 123)));
      assert.strictEqual(id, generated, `${name}: should fall back to generated terrain`);
      assert.ok(fs.existsSync(`${file}.corrupt`), `${name}: bad file was not set aside`);
      fs.unlinkSync(`${file}.corrupt`);
    }
    console.log(`ok ${Object.keys(damaged).length} kinds of damaged save file`);

    // A crash in the middle of a save leaves a .tmp file; the old save must win.
    fs.writeFileSync(file, good);
    fs.writeFileSync(`${file}.tmp`, "half written garbage");
    assert.strictEqual(makeWorld().getBlockId(at(-37, 70, 123)), 35);
    console.log("ok leftover temp file from a crash is ignored");

    // A failed disk write is reported (not thrown) and tried again later.
    const brokenDir = path.join(workDir, "broken");
    const broken = new World(createNaturalGenerator(1337), new WorldStorage(brokenDir));
    broken.setBlock(at(1, 70, 1), Block.Stone);
    fs.rmSync(brokenDir, { recursive: true });
    assert.deepStrictEqual(quiet(() => broken.saveDirtyChunks()), { saved: 0, failed: 1 }, "a failed save must be reported");
    fs.mkdirSync(brokenDir);
    assert.deepStrictEqual(broken.saveDirtyChunks(), { saved: 1, failed: 0 }, "a failed save must be retried");
    console.log("ok failed save is retried");
  }

  // ------------------------------------------- failures while reading or writing
  {
    const { writeFileAtomic } = await import("../src/util/atomicWrite");
    const { MinecraftServer } = await import("../src/game/Server");
    const at = (x: number, y: number, z: number) => ({ x, y, z });
    const dir = path.join(workDir, "io-faults");
    const makeWorld = () => new World(createNaturalGenerator(1337), new WorldStorage(dir));

    const original = makeWorld();
    original.setBlock(at(40, 70, 40), 35, 3); // chunk 2,2
    original.saveDirtyChunks();
    const file = path.join(dir, "2.2.edits");
    const goodBytes = fs.readFileSync(file);

    // A read error (not bad content) must not rename the save or lose the edit.
    const realRead = fs.readFileSync;
    let failReads = true;
    (fs as { readFileSync: unknown }).readFileSync = (p: unknown, ...rest: unknown[]) => {
      if (failReads && String(p).endsWith("2.2.edits")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    };
    try {
      const w = makeWorld();
      assert.throws(() => quiet(() => w.getChunk(2, 2)), /Cannot read saved chunk 2,2/);
      assert.ok(fs.existsSync(file), "an unreadable save must stay where it is");
      assert.ok(!fs.existsSync(file + ".corrupt"), "an unreadable save must not be called corrupt");
      assert.strictEqual(w.loadedChunkCount, 0, "a chunk that failed to load must not be cached");
      assert.deepStrictEqual(w.saveDirtyChunks(), { saved: 0, failed: 0 }); // nothing to overwrite the real save with
      failReads = false; // the disk recovers
      assert.strictEqual(w.getBlockId(at(40, 70, 40)), 35, "edit must come back once the disk works again");
    } finally {
      (fs as { readFileSync: unknown }).readFileSync = realRead;
    }
    console.log("ok a read error is not mistaken for a damaged file");

    // A tiny file that expands hugely must be rejected without allocating the output.
    const bomb = Buffer.concat([goodBytes.subarray(0, 5), zlib.deflateSync(Buffer.alloc(50_000_000))]);
    assert.ok(bomb.length < 100_000, "fixture should be small on disk");
    assert.throws(() => decodeEdits(bomb), /larger than|too large|maxOutputLength/i);
    fs.writeFileSync(file, bomb);
    const plainTerrain = new World(createNaturalGenerator(1337)).getBlockId(at(40, 70, 40)); // no saves involved
    assert.strictEqual(quiet(() => makeWorld().getBlockId(at(40, 70, 40))), plainTerrain, "bad file: use generated terrain");
    assert.ok(fs.existsSync(file + ".corrupt"), "the bomb should be set aside");
    fs.unlinkSync(file + ".corrupt");
    // A file bigger than any valid save is rejected from its size alone.
    fs.writeFileSync(file, Buffer.alloc(2_000_000, 1));
    quiet(() => makeWorld().getBlockId(at(40, 70, 40)));
    assert.ok(fs.existsSync(file + ".corrupt"), "an oversized file should be set aside");
    fs.unlinkSync(file + ".corrupt");
    console.log("ok decompression bombs and oversized files are refused");

    // writeFileAtomic: partial writes are completed, and a failure leaves the old file untouched.
    const target = path.join(workDir, "atomic.txt");
    writeFileAtomic(target, "old contents");
    const realWrite = fs.writeSync;
    (fs as { writeSync: unknown }).writeSync = (fd: number, buf: Buffer, offset: number, length: number) =>
      (realWrite as (...a: unknown[]) => number)(fd, buf, offset, Math.min(length, 3)); // 3 bytes at a time
    try {
      writeFileAtomic(target, "x".repeat(1000));
    } finally {
      (fs as { writeSync: unknown }).writeSync = realWrite;
    }
    assert.strictEqual(fs.readFileSync(target, "utf8"), "x".repeat(1000), "a partial write must not truncate the file");
    const realRename = fs.renameSync;
    (fs as { renameSync: unknown }).renameSync = () => {
      throw new Error("simulated crash before rename");
    };
    try {
      assert.throws(() => writeFileAtomic(target, "new contents"));
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }
    assert.strictEqual(fs.readFileSync(target, "utf8"), "x".repeat(1000), "a failed save must leave the old file intact");
    console.log("ok atomic writes survive partial writes and a crash before rename");

    // The server reports an unsaved world instead of pretending it worked (index.ts relies on this).
    const server = new MinecraftServer();
    server.world.setBlock(at(500, 70, 500), Block.Stone);
    const saveFolder = path.join(workDir, "world", "natural-1337");
    const parked = saveFolder + "-parked";
    fs.renameSync(saveFolder, parked);
    fs.writeFileSync(saveFolder, "a file where the folder should be"); // makes every write fail
    const failedSave = quiet(() => server.saveWorld());
    assert.strictEqual(failedSave.failed, 1, "server.saveWorld must report the chunk it could not save");
    fs.unlinkSync(saveFolder);
    fs.renameSync(parked, saveFolder);
    assert.deepStrictEqual(server.saveWorld(), { saved: 1, failed: 0 }, "the retry must succeed once the disk is fine");
    console.log("ok a failed final save is reported, then retried successfully");
  }

  console.log("ALL CORE CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("CORE CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`(could not delete the temporary folder ${workDir}; it is safe to delete by hand)`);
    }
  });
