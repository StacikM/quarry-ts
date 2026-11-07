import type { EventName, ServerEvents } from "./types";
import { formatError, logger } from "../util/logger";

type Handler<E extends EventName> = (event: ServerEvents[E]) => void;

interface Registration {
  owner: string; // plugin name, so we can remove its handlers when it's disabled
  handler: Handler<EventName>;
}

/**
 * Lets the server announce things ("a player chatted") without knowing who
 * is listening. Plugins subscribe through their PluginApi.
 */
export class EventBus {
  private readonly registrations = new Map<EventName, Registration[]>();

  /** Told how long each handler took (the plugin manager uses it to find slow plugins). */
  constructor(private readonly onTiming?: (owner: string, event: string, ms: number) => void) {}

  on<E extends EventName>(owner: string, event: E, handler: Handler<E>): void {
    const list = this.registrations.get(event) ?? [];
    list.push({ owner, handler: handler as Handler<EventName> });
    this.registrations.set(event, list);
  }

  /**
   * Calls every handler in the order they were added and returns the same
   * event object. Handlers may change it (e.g. edit `message`) or set
   * `cancelled = true`; the code that emitted the event checks afterwards.
   *
   * A plugin that throws can't break the server or other plugins: the error
   * is logged and we move on to the next handler.
   */
  emit<E extends EventName>(event: E, payload: ServerEvents[E]): ServerEvents[E] {
    for (const { owner, handler } of this.registrations.get(event) ?? []) {
      const startedAt = performance.now();
      try {
        handler(payload);
      } catch (err) {
        logger.error(`Plugin "${owner}" crashed handling ${event}: ${formatError(err)}`);
      }
      this.onTiming?.(owner, event, performance.now() - startedAt);
    }
    return payload;
  }

  removeAll(owner: string): void {
    for (const [event, list] of this.registrations) {
      this.registrations.set(
        event,
        list.filter((r) => r.owner !== owner),
      );
    }
  }
}
