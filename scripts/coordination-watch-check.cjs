const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { incomingChange, watchFile } = require("./watch-coordination.cjs");
const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(root, ".coordination-watch-check-"));
const file = path.join(fixture, "messages.txt");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  assert.equal(incomingChange("same", "same"), false);
  assert.equal(incomingChange("hello\n", "hello\n\n[CHATGPT] #99: Reply.\n"), false);
  assert.equal(incomingChange("hello\n", "hello\nHuman request\n"), true);
  assert.equal(incomingChange("[CHATGPT] #1: Text\n", "[CHATGPT] #1: HUMAN INSERT Text\n"), true);
  fs.writeFileSync(file, "baseline\n");
  let calls = 0;
  const watcher = watchFile(file, () => { calls++; }, { debounceMs: 50 });
  try {
    await pause(120);
    assert.equal(calls, 0, "idle must make zero model calls");
    fs.writeFileSync(file, "baseline\n");
    await pause(120);
    assert.equal(calls, 0, "same-content writes must make zero calls");
    fs.appendFileSync(file, "[CHATGPT] #99: Reply.\n");
    await pause(120);
    assert.equal(calls, 0, "our own reply must not create a loop");
    fs.appendFileSync(file, "Human message\n");
    fs.appendFileSync(file, "more of the same message\n");
    await pause(120);
    assert.equal(calls, 1, "a burst of incoming changes produces one call");
    const next = path.join(fixture, "replacement.txt");
    fs.writeFileSync(next, "Human changed the whole file\n");
    fs.renameSync(next, file);
    await pause(120);
    assert.equal(calls, 2, "atomic replacement is detected");
    console.log("Watcher checks passed: zero calls while idle/unchanged/own replies; one per incoming change burst; atomic replacements detected.");
  } finally { watcher.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(path.resolve(fixture)) !== root || !path.basename(fixture).startsWith(".coordination-watch-check-")) throw new Error("Unsafe cleanup");
  fs.rmSync(fixture, { recursive: true, force: true });
});
