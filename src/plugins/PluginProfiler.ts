import { warnSlow } from "../util/slowLog";

/** One plugin handler or task that takes longer than this is reported (a whole tick is 50 ms). */
export const SLOW_PLUGIN_MS = 25;

interface Usage {
  totalMs: number;
  calls: number;
  worstMs: number;
  worstWhat: string;
}

/**
 * Keeps track of how much time each plugin takes in event handlers and scheduled tasks, so a plugin that makes the
 * server laggy can be named: /perf lists the plugins by time, and a single call over SLOW_PLUGIN_MS is warned about.
 */
export class PluginProfiler {
  private readonly usage = new Map<string, Usage>();

  /** `what` is the event name, or "task" for a scheduled task. */
  record(owner: string, what: string, ms: number): void {
    let usage = this.usage.get(owner);
    if (!usage) {
      usage = { totalMs: 0, calls: 0, worstMs: 0, worstWhat: "" };
      this.usage.set(owner, usage);
    }
    usage.totalMs += ms;
    usage.calls++;
    if (ms > usage.worstMs) {
      usage.worstMs = ms;
      usage.worstWhat = what;
    }
    if (ms >= SLOW_PLUGIN_MS) {
      warnSlow(`plugin:${owner}:${what}`, `Plugin "${owner}" was slow in ${what}: ${ms.toFixed(0)} ms (a tick is 50 ms, so this froze the server for that long)`);
    }
  }

  /** The plugins that used the most time, busiest first. */
  top(count: number): { owner: string; totalMs: number; calls: number; worstMs: number; worstWhat: string }[] {
    return [...this.usage.entries()]
      .map(([owner, usage]) => ({ owner, ...usage }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, count);
  }

  reset(): void {
    this.usage.clear();
  }
}
