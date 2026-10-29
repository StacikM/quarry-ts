/** Run: node scripts/git-hooks-check.cjs. Uses temporary message files, creates no commits. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(root, ".git-hook-check-"));
const message = path.join(fixture, "message.txt");
function run(file) {
  const result = spawnSync("git", ["hook", "run", "prepare-commit-msg", "--", file], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result;
}
try {
  fs.writeFileSync(message, "Test subject\n\nA body.\n");
  run(message);
  run(message);
  const content = fs.readFileSync(message, "utf8");
  for (const value of ["Claude <noreply@anthropic.com>", "Codex <noreply@openai.com>"]) {
    assert.equal(content.split(/\r?\n/).filter((line) => line.toLowerCase() === `co-authored-by: ${value}`.toLowerCase()).length, 1);
  }
  const missing = run(path.join(fixture, "does-not-exist.txt"));
  assert.match(missing.stderr, /warning: could not add/);
  fs.chmodSync(message, 0o444);
  run(message);
  console.log("Git hook checks passed: both trailers exactly once, missing-file exit 0 with warning, read-only message exit 0.");
} finally {
  if (fs.existsSync(message)) fs.chmodSync(message, 0o666);
  if (path.dirname(path.resolve(fixture)) !== root || !path.basename(fixture).startsWith(".git-hook-check-")) throw new Error("Unsafe cleanup target");
  fs.rmSync(fixture, { recursive: true, force: true });
}
