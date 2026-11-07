/**
 * Checks the "is there a newer version on GitHub" check: how the running commit is found, what GitHub's answers
 * mean, what is said in the console, and that it never throws. GitHub is replaced by a stand-in: no network is used.
 * Run with:  npx tsx scripts/version-check-check.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkForUpdate, describeUpdate, readBuildInfo, readGitHead, readGitRepository, startUpdateChecks, REPOSITORY,
  type BuildInfo, type Fetch,
} from "../src/versionCheck";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const build: BuildInfo = { commit: A, branch: "mc-1.21.11" };

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A GitHub that answers from a table, and remembers what it was asked. */
function github(answers: Record<string, Response | Error>): { fetcher: Fetch; asked: string[]; headers: Record<string, string>[] } {
  const asked: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetcher: Fetch = async (url, init) => {
    asked.push(url.replace("https://api.github.com/repos/", ""));
    headers.push(init.headers);
    const key = Object.keys(answers).find((pattern) => url.includes(pattern));
    const answer = key ? answers[key] : json(404, {});
    if (answer instanceof Error) throw answer;
    return answer.clone();
  };
  return { fetcher, asked, headers };
}
const branch = (sha: string, message = "Add something"): Response => json(200, { commit: { sha, commit: { message: `${message}\n\nlong text` } } });

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-version-"));

  // ---------------------------------------------------------------- which version is running
  assert.strictEqual(readBuildInfo(root), null, "nothing known in an empty folder");
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/mc-1.21.11\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "mc-1.21.11"), `${A}\n`);
  assert.deepStrictEqual(readBuildInfo(root), { commit: A, branch: "mc-1.21.11", repository: undefined }, "read from the .git folder, without git installed");

  fs.rmSync(path.join(root, ".git", "refs", "heads", "mc-1.21.11"));
  fs.writeFileSync(path.join(root, ".git", "packed-refs"), `# pack-refs\n${B} refs/heads/other\n${C} refs/heads/mc-1.21.11\n`);
  assert.strictEqual(readGitHead(root)?.commit, C, "or from packed-refs");

  fs.writeFileSync(path.join(root, ".git", "HEAD"), `${A}\n`);
  assert.strictEqual(readGitHead(root), null, "a detached head has no branch to compare with");
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/mc-1.21.11\n");

  fs.writeFileSync(path.join(root, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/SomeoneElse/their-fork.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "x"]\n\tremote = origin\n');
  assert.strictEqual(readGitRepository(path.join(root, ".git")), "SomeoneElse/their-fork", "a fork checks its own repository");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Owner/repo.git\n');
  assert.strictEqual(readGitRepository(path.join(root, ".git")), "Owner/repo", "also the ssh form");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\n\turl = https://gitlab.example.com/a/b.git\n');
  assert.strictEqual(readGitRepository(path.join(root, ".git")), undefined, "only GitHub is asked");

  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ commit: B, branch: "main", repository: "Me/mine", builtAt: "now" }));
  assert.deepStrictEqual(readBuildInfo(root), { commit: B, branch: "main", repository: "Me/mine" }, "the build-info file written at build time wins (the .git folder may be gone later)");
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ commit: "short", branch: "main" }));
  assert.strictEqual(readBuildInfo(root)?.commit, C, "a damaged build-info file is ignored");
  console.log("ok finding out which version is running");

  // ---------------------------------------------------------------- up to date: one request
  {
    const g = github({ "/branches/": branch(A) });
    const status = await checkForUpdate(build, g.fetcher);
    assert.deepStrictEqual(status, { kind: "current", build });
    assert.deepStrictEqual(g.asked, [`${REPOSITORY}/branches/mc-1.21.11`], "one small request when nothing changed");
    assert.ok(g.headers[0]["User-Agent"] === "quarry-ts-update-check" && !JSON.stringify(g.headers).includes("@"), "a plain client name, no personal details");
    assert.deepStrictEqual(describeUpdate(status), { level: "info", text: `Quarry.ts is up to date (aaaaaaa on mc-1.21.11).` });
    console.log("ok up to date");
  }

  // ---------------------------------------------------------------- outdated
  {
    const g = github({ "/branches/": branch(B, "Add TNT"), "/compare/": json(200, { status: "ahead", ahead_by: 3, behind_by: 0 }) });
    const status = await checkForUpdate({ ...build, repository: "Owner/fork" }, g.fetcher);
    assert.deepStrictEqual(status, { kind: "outdated", build: { ...build, repository: "Owner/fork" }, behindBy: 3, latestCommit: B, latestMessage: "Add TNT" });
    assert.ok(g.asked[1].startsWith(`Owner/fork/compare/${A}...mc-1.21.11`) && g.asked[1].includes("per_page=1"), "the build's own repository is asked, with a small answer");
    const said = describeUpdate(status);
    assert.strictEqual(said.level, "warn", "it is a warning, so it stands out");
    assert.ok(said.text.includes("3 commits behind mc-1.21.11") && said.text.includes('"Add TNT" (bbbbbbb)') && said.text.includes("Reinstall") && said.text.includes("github.com/Owner/fork/compare/aaaaaaa...mc-1.21.11"));
    const one = describeUpdate({ ...status, behindBy: 1 } as never);
    assert.ok(one.text.includes("1 commit behind"), "singular");
    console.log("ok outdated");
  }

  // ---------------------------------------------------------------- ahead, diverged and identical
  assert.strictEqual((await checkForUpdate(build, github({ "/branches/": branch(B), "/compare/": json(200, { status: "behind", behind_by: 2 }) }).fetcher)).kind, "ahead");
  assert.strictEqual((await checkForUpdate(build, github({ "/branches/": branch(B), "/compare/": json(200, { status: "diverged" }) }).fetcher)).kind, "diverged");
  assert.strictEqual((await checkForUpdate(build, github({ "/branches/": branch(B), "/compare/": json(200, { status: "identical" }) }).fetcher)).kind, "current");
  console.log("ok ahead, diverged and identical");

  // ---------------------------------------------------------------- things that go wrong never throw
  const unknown = async (answers: Record<string, Response | Error>, input: BuildInfo | null = build): Promise<string> => {
    const status = await checkForUpdate(input, github(answers).fetcher);
    assert.strictEqual(status.kind, "unknown");
    const said = describeUpdate(status);
    assert.strictEqual(said.level, "info", "not being able to check is not a warning");
    return said.text;
  };
  assert.match(await unknown({}, null), /does not know which version/);
  assert.match(await unknown({ "/branches/": json(404, {}) }), /no public branch called mc-1.21.11/);
  assert.match(await unknown({ "/branches/": branch(B), "/compare/": json(404, {}) }), /not on GitHub/, "a local commit that was never pushed");
  assert.match(await unknown({ "/branches/": json(403, { message: "rate limit" }) }), /limiting requests/);
  assert.match(await unknown({ "/branches/": json(429, {}) }), /limiting requests/);
  assert.match(await unknown({ "/branches/": json(500, {}) }), /answered 500/);
  assert.match(await unknown({ "/branches/": new Error("getaddrinfo ENOTFOUND api.github.com") }), /could not reach GitHub \(getaddrinfo ENOTFOUND/);
  assert.match(await unknown({ "/branches/": json(200, { nonsense: true }) }), /does not understand/);
  const slow = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  assert.match(await unknown({ "/branches/": slow }), /too slow/);
  assert.match(await unknown({ "/branches/": new Response("<html>not json</html>", { status: 200 }) }), /could not reach GitHub/, "an answer that is not JSON");
  console.log("ok errors are explained, never thrown");

  // ---------------------------------------------------------------- the background check
  {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (line: string) => lines.push(`INFO ${line}`);
    console.warn = (line: string) => lines.push(`WARN ${line}`);
    try {
      const g = github({ "/branches/": branch(B, "Newer"), "/compare/": json(200, { status: "ahead", ahead_by: 2 }) });
      const running = startUpdateChecks({ build, fetcher: g.fetcher, everyMs: 20 });
      assert.deepStrictEqual(lines, [], "it does not wait for GitHub: the server starts first");
      await new Promise((resolve) => setTimeout(resolve, 150));
      running.stop();
      assert.ok(lines.length >= 2, "and repeats");
      assert.ok(lines.every((line) => line.startsWith("WARN") && line.includes("2 commits behind")), "a newer version is mentioned every time");

      lines.length = 0;
      const same = github({ "/branches/": branch(A) });
      const again = startUpdateChecks({ build, fetcher: same.fetcher, everyMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      again.stop();
      assert.strictEqual(lines.length, 1, "'up to date' is said once, not every time");
      assert.ok(lines[0].includes("up to date"));

      lines.length = 0;
      const down = startUpdateChecks({ build, fetcher: github({ "/branches/": new Error("offline") }).fetcher, everyMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      down.stop();
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0].startsWith("INFO") && lines[0].includes("Could not check for updates"), "offline: one quiet line");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    console.log("ok the background check");
  }

  console.log("ALL VERSION CHECKS PASS");
}

main().catch((err) => {
  console.error("VERSION CHECK FAILED:", err);
  process.exitCode = 1;
});
