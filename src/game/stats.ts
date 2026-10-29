import { monitorEventLoopDelay } from "node:perf_hooks";

type LoopMonitor = ReturnType<typeof monitorEventLoopDelay>;

/** The server aims for 20 ticks per second, like vanilla Minecraft: one tick every 50 ms. */
export const TARGET_TPS = 20;

/** How many seconds of tick history we keep: enough for the 15 minute average. */
const HISTORY_SECONDS = 15 * 60 + 5;
/**
 * How often we ask the program "are you there?" to measure stalls. The measurement
 * includes this interval, so we subtract it. (On Windows timers also wake in steps
 * of about 15 ms, so a few milliseconds of lateness on a healthy server is normal.)
 */
const LOOP_RESOLUTION_MS = 10;
/** How many recent ticks the "time per tick" figures cover. */
const TICK_TIME_SAMPLES = 200;

/** "142.3 MB". Uses 1024 like Task Manager does. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export interface EventLoopStats {
  meanMs: number;
  p99Ms: number;
  maxMs: number;
}

/**
 * Measures how healthy the server is: ticks per second (TPS), how long each
 * tick takes, how long the program stalls, and how much CPU it uses.
 *
 * TPS works by counting how many ticks happened in each second of the last
 * 15 minutes. A healthy server shows 20.0. If something blocks the program
 * for a while (for example generating lots of new chunks), ticks arrive late,
 * fewer fit in a second, and the number drops.
 */
export class ServerStats {
  /** Ticks counted per second, in a ring: the slot for second S is S % HISTORY_SECONDS. */
  private readonly ticksPerSecond = new Int32Array(HISTORY_SECONDS);
  private currentSecond: number | null = null;
  private firstSecond = 0;

  private readonly tickTimes = new Float64Array(TICK_TIME_SAMPLES);
  private tickTimeCount = 0;

  private loopMonitor: LoopMonitor | null = null;
  private loopWindowStartedAt: number;

  private cpuTimer: NodeJS.Timeout | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();
  private cpuPercentRecent = 0;

  readonly startedAt: number;

  /** `now` returns milliseconds. It can be replaced so tests control the clock. */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.loopWindowStartedAt = now();
  }

  /** Starts measuring CPU use and program stalls. Call stop() when the server stops. */
  start(): void {
    this.loopMonitor = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loopMonitor.enable();
    this.loopWindowStartedAt = this.now();

    this.cpuTimer = setInterval(() => this.sampleCpu(), 5000);
    this.cpuTimer.unref(); // never keeps the process alive on its own
  }

  stop(): void {
    this.loopMonitor?.disable();
    this.loopMonitor = null;
    if (this.cpuTimer) clearInterval(this.cpuTimer);
    this.cpuTimer = null;
  }

  /** Call once after every tick, with how long the tick's own work took. */
  recordTick(durationMs: number): void {
    const second = Math.floor(this.now() / 1000);
    this.advanceTo(second);
    this.ticksPerSecond[second % HISTORY_SECONDS]++;

    this.tickTimes[this.tickTimeCount % TICK_TIME_SAMPLES] = durationMs;
    this.tickTimeCount++;
  }

  /** Moves the ring forward to `second`, clearing the seconds in between. */
  private advanceTo(second: number): void {
    if (this.currentSecond === null) {
      this.currentSecond = second;
      this.firstSecond = second;
      return;
    }
    if (second <= this.currentSecond) return;

    const gap = Math.min(second - this.currentSecond, HISTORY_SECONDS);
    for (let i = 1; i <= gap; i++) {
      this.ticksPerSecond[(this.currentSecond + i) % HISTORY_SECONDS] = 0;
    }
    this.currentSecond = second;
  }

  /**
   * Average ticks per second over the last `windowSeconds`, at most 20.
   * Only completed seconds count, and if the server is younger than the window
   * we average over its age.
   */
  tps(windowSeconds: number): number {
    const nowSecond = Math.floor(this.now() / 1000);
    this.advanceTo(nowSecond);

    // The first second is partial (ticks start mid-second), so it is left out.
    const completed = nowSecond - this.firstSecond - 1;
    if (this.currentSecond === null || completed <= 0) return TARGET_TPS;

    const window = Math.min(windowSeconds, completed, HISTORY_SECONDS - 1);
    let ticks = 0;
    for (let i = 1; i <= window; i++) {
      ticks += this.ticksPerSecond[(nowSecond - i) % HISTORY_SECONDS];
    }
    return Math.min(TARGET_TPS, ticks / window);
  }

  /** How long one tick's work takes, over the most recent ticks. 50 ms is the budget. */
  tickTime(): { averageMs: number; maxMs: number } {
    const count = Math.min(this.tickTimeCount, TICK_TIME_SAMPLES);
    if (count === 0) return { averageMs: 0, maxMs: 0 };

    let total = 0;
    let max = 0;
    for (let i = 0; i < count; i++) {
      total += this.tickTimes[i];
      max = Math.max(max, this.tickTimes[i]);
    }
    return { averageMs: total / count, maxMs: max };
  }

  /**
   * How late the program is to react, in milliseconds: the average, the slowest 1%, and the worst.
   * Big numbers mean something kept the program busy and every player felt a freeze.
   * Covers the time since the server started or since the last reset.
   */
  eventLoop(): (EventLoopStats & { sinceSeconds: number }) | null {
    if (!this.loopMonitor || this.loopMonitor.count === 0) return null;
    const toMs = (nanoseconds: number): number => Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS);
    return {
      meanMs: toMs(this.loopMonitor.mean),
      p99Ms: toMs(this.loopMonitor.percentile(99)),
      maxMs: toMs(this.loopMonitor.max),
      sinceSeconds: Math.round((this.now() - this.loopWindowStartedAt) / 1000),
    };
  }

  /** Starts the stall measurement over, so old spikes stop showing up. */
  resetEventLoop(): void {
    this.loopMonitor?.reset();
    this.loopWindowStartedAt = this.now();
  }

  private sampleCpu(): void {
    const cpu = process.cpuUsage();
    const at = process.hrtime.bigint();
    const usedMicros = cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system);
    const elapsedMicros = Number(at - this.lastCpuAt) / 1000;
    if (elapsedMicros > 0) this.cpuPercentRecent = (usedMicros / elapsedMicros) * 100;
    this.lastCpu = cpu;
    this.lastCpuAt = at;
  }

  /** CPU use over roughly the last 5 seconds, as a percentage of ONE processor core. */
  cpuPercent(): number {
    return this.cpuPercentRecent;
  }

  uptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAt) / 1000);
  }
}
