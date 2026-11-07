import fs from "node:fs";

/**
 * The CPU limit of the container the server runs in (hosting panels such as Pterodactyl set one), and how often the
 * host has paused the server for using up its allowance. A paused server stalls for up to 100 ms at a time, even when
 * its own work is small, which shows up as lag. This reads the Linux "cgroup" files; elsewhere (Windows, macOS) there is
 * nothing to read and the functions answer null.
 */

export interface CpuLimit {
  /** How many cores the server may use (0.25 = a quarter of one core), or null when there is no limit. */
  cores: number | null;
  /** How many 100 ms accounting periods have passed, and in how many of them the server was paused. Counted from the container's start. */
  periods: number;
  throttledPeriods: number;
  /** How long the server was paused in total. */
  throttledMs: number;
}

function readLines(file: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && Number.isFinite(Number(value))) values[key] = Number(value);
  }
  return values;
}

/** Reads the limit and the pause counters (cgroup version 2 first, then version 1). `root` can be replaced in tests. */
export function readCpuLimit(root = "/sys/fs/cgroup"): CpuLimit | null {
  try {
    const [quota, period] = fs.readFileSync(`${root}/cpu.max`, "utf8").trim().split(/\s+/);
    const stat = readLines(`${root}/cpu.stat`);
    return {
      cores: quota === "max" ? null : Number(quota) / Number(period),
      periods: stat.nr_periods ?? 0,
      throttledPeriods: stat.nr_throttled ?? 0,
      throttledMs: (stat.throttled_usec ?? 0) / 1000,
    };
  } catch {
    // not cgroup version 2
  }
  try {
    const quota = Number(fs.readFileSync(`${root}/cpu/cpu.cfs_quota_us`, "utf8").trim());
    const period = Number(fs.readFileSync(`${root}/cpu/cpu.cfs_period_us`, "utf8").trim());
    const stat = readLines(`${root}/cpu/cpu.stat`);
    return {
      cores: quota > 0 ? quota / period : null, // -1 means no limit
      periods: stat.nr_periods ?? 0,
      throttledPeriods: stat.nr_throttled ?? 0,
      throttledMs: (stat.throttled_time ?? 0) / 1e6, // in nanoseconds
    };
  } catch {
    return null;
  }
}

/** What happened between `start` and `now`: the limit as it is now, and the pauses since then. */
export function throttleSince(start: CpuLimit, now: CpuLimit): CpuLimit {
  return {
    cores: now.cores,
    periods: Math.max(0, now.periods - start.periods),
    throttledPeriods: Math.max(0, now.throttledPeriods - start.throttledPeriods),
    throttledMs: Math.max(0, now.throttledMs - start.throttledMs),
  };
}

/** Plain sentences for /perf. */
export function describeCpuLimit(since: CpuLimit): string[] {
  const lines = [since.cores === null ? "CPU limit of this container: none" : `CPU limit of this container: ${(since.cores * 100).toFixed(0)}% of one core`];
  if (since.throttledPeriods === 0) {
    lines.push("The host has not paused the server for using too much CPU since it started.");
    return lines;
  }
  const share = since.periods > 0 ? (since.throttledPeriods / since.periods) * 100 : 0;
  lines.push(
    `The host paused the server in ${since.throttledPeriods} of ${since.periods} periods since it started (${share.toFixed(1)}%, ${(since.throttledMs / 1000).toFixed(1)} s in total).`,
  );
  if (share >= 1 || since.throttledMs >= 500) {
    lines.push("That is a cause of lag: the server used its whole CPU allowance. Raise its CPU limit in the panel (Build Configuration), or set it to 0 for no limit.");
  }
  return lines;
}
