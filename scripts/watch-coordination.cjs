/** Local file events -> Codex queue. No model calls or polling while the file is unchanged. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

function difference(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { removed: before.slice(start, oldEnd), added: after.slice(start, newEnd) };
}

function incomingChange(before, after) {
  if (before === after) return false;
  const { removed, added } = difference(before, after);
  // ChatGPT replies use one attributed line. Human edits anywhere else still wake the chat.
  return (removed + "\n" + added).split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text && !/^\[(?:CHATGPT\]|ChatGPT\s*\|)/i.test(text);
  });
}

function watchFile(file, notify, { debounceMs = 2000, log = () => {} } = {}) {
  let last = fs.readFileSync(file, "utf8");
  let timer;
  const onEvent = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let current;
      try { current = fs.readFileSync(file, "utf8"); }
      catch (error) { log(`Read deferred: ${error.code}`); return; }
      const previous = last;
      last = current;
      if (!incomingChange(previous, current)) return;
      log("Incoming content changed; queueing one wakeup.");
      Promise.resolve().then(notify).catch((error) => log(`Delivery failed: ${error.message}`));
    }, debounceMs);
  };
  // Watch the directory so atomic file replacement remains visible.
  const watcher = fs.watch(path.dirname(file), (_, filename) => {
    if (filename === null || String(filename).toLowerCase() === path.basename(file).toLowerCase()) onEvent();
  });
  watcher.on("error", (error) => log(`Watcher error: ${error.message}`));
  return { close() { clearTimeout(timer); watcher.close(); } };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const local = path.join(root, ".coordination-watch");
  const stateFile = path.join(local, "state.json");
  const stopFile = path.join(local, "stop.json");
  fs.mkdirSync(local, { recursive: true });
  if (process.argv.includes("--stop")) {
    if (!fs.existsSync(stateFile)) { console.log("Watcher is not running."); return; }
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stopFile, JSON.stringify({ token: state.token }));
    console.log("Stop requested.");
    return;
  }
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    let alive = true;
    try { process.kill(state.pid, 0); } catch { alive = false; }
    if (alive) throw new Error("A watcher already has this workspace. Stop it before starting another.");
    fs.unlinkSync(stateFile);
  }
  const config = JSON.parse(fs.readFileSync(path.join(local, "config.json"), "utf8"));
  const token = crypto.randomUUID();
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  const file = path.join(root, "claudeandchatgpt.txt");
  const notify = () => new Promise((resolve, reject) => {
    const message = "[File-change event] claudeandchatgpt.txt has new incoming content. Read its full contents/diff, prioritize human messages, and coordinate with Claude within the authorized scope. Do not start a recurring automation. Append any ChatGPT reply as one attributed line so the watcher ignores it. If no action is needed, keep the response quiet.";
    execFile(config.codexPath, ["queue", "--thread", config.threadId, "--message", message],
      { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) { reject(new Error(stderr.trim() || error.message)); return; }
        log("Wakeup accepted by Codex queue.");
        resolve();
      });
  });
  const watcher = watchFile(file, notify, { log });
  const control = fs.watch(local, (_, filename) => {
    if (String(filename) !== "stop.json") return;
    try {
      if (JSON.parse(fs.readFileSync(stopFile, "utf8")).token === token) shutdown();
    } catch { /* Wait for the complete control-file write. */ }
  });
  function shutdown() {
    watcher.close(); control.close();
    try { if (JSON.parse(fs.readFileSync(stateFile, "utf8")).token === token) fs.unlinkSync(stateFile); } catch {}
    try { fs.unlinkSync(stopFile); } catch {}
    log("Stopped.");
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
  log("Ready. Local file events only; unchanged contents and ChatGPT replies do not wake the model.");
}

module.exports = { difference, incomingChange, watchFile };
if (require.main === module) main();
