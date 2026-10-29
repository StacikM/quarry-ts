import type { PluginCommand } from "./types";

interface Registered {
  owner: string;
  command: PluginCommand;
}

/**
 * Every chat command, whether built in ("core") or added by a plugin.
 * Names are case-insensitive. The first one registered wins, so a plugin
 * can't silently replace a core command.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Registered>();

  /** Returns false if the name is already taken. */
  register(owner: string, command: PluginCommand): boolean {
    const key = command.name.toLowerCase();
    if (this.commands.has(key)) return false;
    this.commands.set(key, { owner, command });
    return true;
  }

  get(name: string): PluginCommand | undefined {
    return this.commands.get(name.toLowerCase())?.command;
  }

  all(): PluginCommand[] {
    return [...this.commands.values()].map((r) => r.command);
  }

  removeAll(owner: string): void {
    for (const [name, registered] of this.commands) {
      if (registered.owner === owner) this.commands.delete(name);
    }
  }
}
