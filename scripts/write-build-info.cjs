#!/usr/bin/env node
/**
 * Writes dist/build-info.json: which git commit, branch and repository the server was built from. The server uses it
 * to tell you when GitHub has a newer version (src/versionCheck.ts). It runs at the end of  npm run build.
 * If this is not a git checkout (or git is not installed) there is simply no file, and the build still succeeds.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

try {
  const commit = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  let repository;
  try {
    repository = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(git("remote", "get-url", "origin"))?.[1];
  } catch {
    // no remote called origin
  }
  if (!/^[0-9a-f]{40}$/.test(commit) || branch === "HEAD") throw new Error("no branch");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ commit, branch, repository, builtAt: new Date().toISOString() }, null, 2) + "\n");
} catch {
  try {
    fs.rmSync(path.join(root, "dist", "build-info.json"), { force: true }); // an old file would name the wrong version
  } catch {
    // nothing to remove
  }
}
