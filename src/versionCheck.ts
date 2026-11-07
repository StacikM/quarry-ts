import fs from "node:fs";
import path from "node:path";
import { logger } from "./util/logger";

/**
 * Tells you in the console when GitHub has a newer version of the server than the one that is running.
 *
 * The running version is a git commit: it is written to dist/build-info.json when the server is built
 * (npm run build), or else read from the .git folder next to the program. GitHub is asked for the newest
 * commit of the same branch (one request to its public API, no account needed, nothing about you is sent
 * except the address of your server, which any web request carries). It can be switched off with
 * "checkForUpdates": false in config.json.
 */

/** The repository the updates come from. */
export const REPOSITORY = "StacikM/quarry-ts";

/** How often a running server asks again. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export interface BuildInfo {
  commit: string;
  branch: string;
  /** "owner/name" on GitHub, when it is known (from the git remote); otherwise REPOSITORY. */
  repository?: string;
}

export type UpdateStatus =
  /** The server runs the newest commit of its branch. */
  | { kind: "current"; build: BuildInfo }
  /** GitHub has newer commits. */
  | { kind: "outdated"; build: BuildInfo; behindBy: number; latestCommit: string; latestMessage: string }
  /** This build has commits GitHub does not have (you are developing it). */
  | { kind: "ahead"; build: BuildInfo; aheadBy: number }
  | { kind: "diverged"; build: BuildInfo }
  /** Could not tell: no build information, GitHub does not know the commit, no network, rate limit... */
  | { kind: "unknown"; reason: string };

/** What the fetch function we use has to look like (so tests can give one that never touches the network). */
export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

// ------------------------------------------------------------------ which version is running

/** The commit this server was built from, or null if that cannot be found out. */
export function readBuildInfo(root: string = path.resolve(__dirname, "..")): BuildInfo | null {
  try {
    const info: unknown = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
    const { commit, branch } = info as Partial<BuildInfo>;
    const { repository } = info as Partial<BuildInfo>;
    if (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) && typeof branch === "string" && branch !== "") {
      return { commit, branch, repository: typeof repository === "string" && validRepository(repository) ? repository : undefined };
    }
  } catch {
    // not built with a build-info file: try git itself
  }
  return readGitHead(root);
}

/** The commit and branch from a .git folder, read from its files so that git does not have to be installed. */
export function readGitHead(root: string): BuildInfo | null {
  try {
    const git = path.join(root, ".git");
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const ref = /^ref: (refs\/heads\/.+)$/.exec(head);
    if (!ref) return null; // a detached head has no branch to compare with
    const branch = ref[1].slice("refs/heads/".length);
    let commit: string | undefined;
    try {
      commit = fs.readFileSync(path.join(git, ref[1]), "utf8").trim();
    } catch {
      const packed = fs.readFileSync(path.join(git, "packed-refs"), "utf8");
      commit = packed.split("\n").find((line) => line.endsWith(` ${ref[1]}`))?.split(" ")[0];
    }
    return commit && /^[0-9a-f]{40}$/.test(commit) ? { commit, branch, repository: readGitRepository(git) } : null;
  } catch {
    return null;
  }
}

const validRepository = (name: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name);

/** "owner/name" from the url of the git remote "origin" if it points at GitHub (so a fork checks its own repository). */
export function readGitRepository(gitFolder: string): string | undefined {
  try {
    const config = fs.readFileSync(path.join(gitFolder, "config"), "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    const match = origin && /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(origin);
    return match && validRepository(match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ asking GitHub

const firstLine = (text: unknown): string => String(text ?? "").split("\n")[0].slice(0, 120);

/** Compares the running build with the newest commit of its branch on GitHub. Never throws. */
export async function checkForUpdate(build: BuildInfo | null, fetcher: Fetch = fetch as Fetch): Promise<UpdateStatus> {
  if (!build) return { kind: "unknown", reason: "this build does not know which version it is (it was not built from a git checkout)" };

  const api = `https://api.github.com/repos/${build.repository ?? REPOSITORY}`;
  const get = async (url: string): Promise<{ status: number; body: any }> => {
    const response = await fetcher(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "quarry-ts-update-check", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  };

  try {
    // One request in the usual case: the newest commit of the branch.
    const latest = await get(`${api}/branches/${encodeURIComponent(build.branch)}`);
    if (latest.status === 404) return { kind: "unknown", reason: `GitHub has no public branch called ${build.branch} in ${build.repository ?? REPOSITORY} (a private repository cannot be checked)` };
    if (latest.status === 403 || latest.status === 429) return { kind: "unknown", reason: "GitHub is limiting requests from this address, it will be tried again later" };
    if (latest.status !== 200) return { kind: "unknown", reason: `GitHub answered ${latest.status}` };
    const latestCommit: string = latest.body?.commit?.sha;
    if (typeof latestCommit !== "string") return { kind: "unknown", reason: "GitHub gave an answer this server does not understand" };
    if (latestCommit === build.commit) return { kind: "current", build };

    // Newer, older or different? per_page=1 keeps the answer small (it lists changed files too).
    const compare = await get(`${api}/compare/${build.commit}...${encodeURIComponent(build.branch)}?per_page=1`);
    if (compare.status === 404) return { kind: "unknown", reason: `this build (${build.commit.slice(0, 7)}) is not on GitHub, so it cannot be compared` };
    if (compare.status !== 200) return { kind: "unknown", reason: `GitHub answered ${compare.status}` };
    switch (compare.body?.status) {
      case "identical":
        return { kind: "current", build };
      case "ahead": // the branch is ahead of this build
        return { kind: "outdated", build, behindBy: Number(compare.body.ahead_by) || 1, latestCommit, latestMessage: firstLine(latest.body?.commit?.commit?.message) };
      case "behind": // this build is ahead of the branch
        return { kind: "ahead", build, aheadBy: Number(compare.body.behind_by) || 1 };
      default:
        return { kind: "diverged", build };
    }
  } catch (err) {
    return { kind: "unknown", reason: `could not reach GitHub (${(err as Error).name === "TimeoutError" ? "too slow" : (err as Error).message})` };
  }
}

// ------------------------------------------------------------------ telling the console

const short = (commit: string): string => commit.slice(0, 7);

/** The text for the console (or /version), and how serious it is. */
export function describeUpdate(status: UpdateStatus): { level: "info" | "warn"; text: string } {
  switch (status.kind) {
    case "current":
      return { level: "info", text: `Quarry.ts is up to date (${short(status.build.commit)} on ${status.build.branch}).` };
    case "outdated":
      return {
        level: "warn",
        text:
          `A newer version of Quarry.ts is available: this server is ${status.behindBy} commit${status.behindBy === 1 ? "" : "s"} behind ${status.build.branch} on GitHub. ` +
          `Newest: "${status.latestMessage}" (${short(status.latestCommit)}). ` +
          `Update: use Reinstall in the panel, or run  git pull && npm install && npm run build  and restart. ` +
          `What changed: https://github.com/${status.build.repository ?? REPOSITORY}/compare/${short(status.build.commit)}...${status.build.branch}`,
      };
    case "ahead":
      return { level: "info", text: `This build (${short(status.build.commit)}) is ${status.aheadBy} commit${status.aheadBy === 1 ? "" : "s"} ahead of ${status.build.branch} on GitHub.` };
    case "diverged":
      return { level: "info", text: `This build (${short(status.build.commit)}) and ${status.build.branch} on GitHub have both changed since they split.` };
    case "unknown":
      return { level: "info", text: `Could not check for updates: ${status.reason}.` };
  }
}

let lastStatus: UpdateStatus | null = null;

/** What the most recent check found, for /version. */
export function lastUpdateStatus(): UpdateStatus | null {
  return lastStatus;
}

export interface UpdateCheckOptions {
  build?: BuildInfo | null;
  fetcher?: Fetch;
  /** How often to ask again; 0 asks only once. */
  everyMs?: number;
}

/**
 * Checks now (in the background: the server does not wait for it) and then every few hours. The console hears about
 * a newer version each time; "up to date" and "could not check" are said only the first time.
 */
export function startUpdateChecks(options: UpdateCheckOptions = {}): { stop(): void } {
  const build = options.build !== undefined ? options.build : readBuildInfo();
  let first = true;

  const run = async (): Promise<void> => {
    const status = await checkForUpdate(build, options.fetcher);
    lastStatus = status;
    const { level, text } = describeUpdate(status);
    if (level === "warn" || first) logger[level](text);
    first = false;
  };
  void run();

  const everyMs = options.everyMs ?? CHECK_EVERY_MS;
  if (everyMs <= 0) return { stop() {} };
  const timer = setInterval(() => void run(), everyMs);
  timer.unref(); // never keeps the server alive
  return { stop: () => clearInterval(timer) };
}
