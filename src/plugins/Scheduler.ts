import { formatError, logger } from "../util/logger";

interface Task {
  owner: string;
  runAtTick: number;
  /** If set, the task re-schedules itself this many ticks after each run. */
  repeatEvery?: number;
  fn: () => void;
  /** Set by removeAll(). A cancelled task never runs and is never re-queued. */
  cancelled?: boolean;
}

/**
 * Runs functions later, measured in server ticks (20 per second).
 * The server calls tick() every 50 ms.
 */
export class Scheduler {
  private currentTick = 0;
  private tasks: Task[] = [];
  /** The batch being run right now, so removeAll() can cancel those too. */
  private running: Task[] = [];

  runLater(owner: string, ticks: number, fn: () => void): void {
    this.tasks.push({ owner, runAtTick: this.currentTick + Math.max(1, ticks), fn });
  }

  runRepeating(owner: string, ticks: number, fn: () => void): void {
    const every = Math.max(1, ticks);
    this.tasks.push({ owner, runAtTick: this.currentTick + every, repeatEvery: every, fn });
  }

  tick(): void {
    this.currentTick++;
    // Tasks added while we're running (by a task) wait until the next tick.
    const due = this.tasks.filter((t) => t.runAtTick <= this.currentTick);
    if (due.length === 0) return;

    this.tasks = this.tasks.filter((t) => t.runAtTick > this.currentTick);
    this.running = due;
    for (const task of due) {
      // An earlier task in this same batch may have disabled this task's plugin.
      if (task.cancelled) continue;
      try {
        task.fn();
      } catch (err) {
        logger.error(`Plugin "${task.owner}" crashed in a scheduled task: ${formatError(err)}`);
      }
      // The task itself may have disabled its own plugin, so check again.
      if (!task.cancelled && task.repeatEvery !== undefined) {
        task.runAtTick = this.currentTick + task.repeatEvery;
        this.tasks.push(task);
      }
    }
  }

  removeAll(owner: string): void {
    for (const task of [...this.tasks, ...this.running]) {
      if (task.owner === owner) task.cancelled = true;
    }
    this.tasks = this.tasks.filter((t) => t.owner !== owner);
  }
}
