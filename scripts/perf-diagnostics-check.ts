/**
 * Checks the tools that explain a laggy server: rate-limited slow warnings, the time each plugin uses, the
 * explanation printed for a slow tick, and the lines in /perf.
 * Run with:  npx tsx scripts/perf-diagnostics-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-perf-"));
process.chdir(workDir);

/** Keeps the CPU busy for `ms` (a plugin doing slow work). */
function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // waiting
  }
}

async function main(): Promise<void> {
  const { warnSlow, resetSlowLog } = await import("../src/util/slowLog");
  const { PluginProfiler, SLOW_PLUGIN_MS } = await import("../src/plugins/PluginProfiler");
  const { EventBus } = await import("../src/plugins/EventBus");
  const { MinecraftServer } = await import("../src/game/Server");
  const { runConsoleCommand } = await import("../src/consoleCommands");

  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (): void => {
    lines.length = 0;
    console.log = (line: string) => lines.push(`INFO ${line}`);
    console.warn = (line: string) => lines.push(`WARN ${line}`);
    console.error = (line: string) => lines.push(`ERROR ${line}`);
  };
  const release = (): void => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };

  try {
    // ---------------------------------------------------------------- the same warning is not printed again and again
    capture();
    resetSlowLog();
    warnSlow("k", "first", 1000, 0);
    warnSlow("k", "second", 1000, 10);
    warnSlow("k", "third", 1000, 20);
    warnSlow("other", "unrelated", 1000, 30);
    assert.strictEqual(lines.length, 2, "one line per key per window");
    warnSlow("k", "fourth", 1000, 1500);
    assert.ok(lines[2].includes("fourth") && lines[2].includes("2 more like it"), "the next line says how many were held back");
    release();
    console.log("ok slow warnings are rate limited");

    // ---------------------------------------------------------------- time per plugin
    capture();
    resetSlowLog();
    const profiler = new PluginProfiler();
    profiler.record("quiet", "playerMove", 1);
    profiler.record("quiet", "playerMove", 2);
    profiler.record("heavy", "playerChat", 10);
    profiler.record("heavy", "a scheduled task", SLOW_PLUGIN_MS + 100);
    const top = profiler.top(5);
    assert.deepStrictEqual(top.map((entry) => entry.owner), ["heavy", "quiet"], "the busiest plugin first");
    assert.deepStrictEqual([top[0].calls, top[0].worstWhat], [2, "a scheduled task"]);
    assert.ok(Math.abs(top[1].totalMs - 3) < 1e-9);
    assert.strictEqual(lines.length, 1, "only the call over the limit is warned about");
    assert.ok(lines[0].startsWith("WARN") && lines[0].includes('Plugin "heavy" was slow in a scheduled task: 125 ms'));
    release();
    console.log("ok time per plugin");

    // ---------------------------------------------------------------- the event bus and the scheduler report their timings
    const seen: Array<[string, string, number]> = [];
    const bus = new EventBus((owner, event, ms) => seen.push([owner, event, ms]));
    bus.on("slowpoke", "playerJoin", () => busy(8));
    bus.on("crasher", "playerJoin", () => {
      throw new Error("boom");
    });
    capture();
    bus.emit("playerJoin", { player: {} as never });
    release();
    assert.deepStrictEqual(seen.map(([owner, event]) => [owner, event]), [["slowpoke", "playerJoin"], ["crasher", "playerJoin"]], "every handler is timed, even one that throws");
    assert.ok(seen[0][2] >= 7, "with the time it really took");
    assert.strictEqual(new EventBus().emit("playerJoin", { player: {} as never }) !== undefined, true, "the timing callback is optional");
    console.log("ok handlers are timed");

    // ---------------------------------------------------------------- a slow tick is explained, and a plugin is named
    const server = new MinecraftServer();
    server.plugins.enable({
      name: "heavyplugin",
      version: "1.0.0",
      onEnable(api) {
        api.runLater(1, () => busy(130));
        api.on("playerChat", () => busy(2));
        api.runLater(2, () => api.saveData({ big: "x".repeat(100) }));
      },
    });
    capture();
    (server as unknown as { tick(): void }).tick();
    release();
    const slowTick = lines.find((line) => line.includes("Slow tick"));
    assert.ok(slowTick, `a tick over 100 ms is explained (${lines.join(" | ")})`);
    assert.match(slowTick!, /Slow tick: 1[3-9]\d ms .*Plugin tasks 1[3-9]\d ms, NPCs and TNT \d+ ms, sending chunks \d+ ms \(loading the map \d+, light \d+, packing \d+\), autosave \d+ ms/);
    assert.ok(lines.some((line) => line.includes('Plugin "heavyplugin" was slow in a scheduled task')), "and the plugin is named");

    capture();
    (server as unknown as { tick(): void }).tick(); // the save task
    release();
    const saved = server.plugins.profiler.top(5).find((entry) => entry.owner === "heavyplugin");
    assert.ok(saved && saved.calls >= 2, "scheduled tasks are counted");
    console.log("ok a slow tick is explained");

    // ---------------------------------------------------------------- saving data is timed too
    const names = server.plugins.profiler.top(5).map((entry) => entry.worstWhat);
    assert.ok(names.includes("a scheduled task"));
    const savedFile = path.join("plugins-data", "heavyplugin.json");
    assert.ok(fs.existsSync(savedFile), "the data was saved");
    server.plugins.profiler.reset();
    server.plugins.enable({ name: "saver", version: "1.0.0", onEnable: (api) => api.saveData({ a: 1 }) });
    assert.strictEqual(server.plugins.profiler.top(5)[0].worstWhat, "saving its data", "a plugin's save shows up under its own name");
    console.log("ok saves are timed");

    // ---------------------------------------------------------------- /perf shows it
    capture();
    runConsoleCommand(server, "perf");
    release();
    const text = lines.join("\n");
    assert.ok(text.includes("Chunks packed for sending"), "the cost of packing chunks is shown");
    server.plugins.profiler.record("heavyplugin", "playerMove", 12);
    capture();
    runConsoleCommand(server, "perf");
    release();
    assert.ok(lines.join("\n").includes("Plugin time since start"), "and the plugins that use the most time");
    assert.ok(lines.join("\n").includes("heavyplugin"));
    console.log("ok /perf lists plugin time");
  } finally {
    release();
  }

  console.log("ALL PERF DIAGNOSTICS CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("PERF DIAGNOSTICS CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
