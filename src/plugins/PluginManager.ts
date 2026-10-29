import fs from "node:fs";
import path from "node:path";
import { EventBus } from "./EventBus";
import { CommandRegistry } from "./CommandRegistry";
import { Scheduler } from "./Scheduler";
import { builtinPlugins } from "./builtin";
import type { Plugin, PluginApi, PluginLogger } from "./types";
import type { MinecraftServer } from "../game/Server";
import { formatError, logger } from "../util/logger";
import { writeFileAtomic } from "../util/atomicWrite";

/** Drop .js files in this folder (next to where you run the server) to add plugins. */
const PLUGINS_DIR = path.resolve("plugins");
/** Each plugin's saved data goes in here as <plugin name>.json */
const DATA_DIR = path.resolve("plugins-data");

/**
 * Finds plugins, gives each one its own PluginApi, and cleans up after them.
 *
 * The EventBus, CommandRegistry and Scheduler are shared by everything, but
 * every registration is tagged with the plugin's name. So disabling a plugin
 * just means "remove everything tagged with this name".
 */
/**
 * Plugin names double as file names and as the owner tag on commands, so we
 * keep them simple. This also means two different names can never end up
 * sharing one data file. "core" belongs to the server's own commands.
 */
const VALID_PLUGIN_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_PLUGIN_NAMES = new Set(["core"]);

export class PluginManager {
  readonly events = new EventBus();
  readonly commands = new CommandRegistry();
  readonly scheduler = new Scheduler();

  private readonly enabled = new Map<string, Plugin>();

  constructor(private readonly server: MinecraftServer) {}

  /** Enables the built-in plugins, then everything in the plugins/ folder. */
  loadAll(): void {
    for (const plugin of builtinPlugins) {
      this.enable(plugin);
    }
    for (const plugin of this.readPluginFiles()) {
      this.enable(plugin);
    }
    logger.info(`Plugins enabled: ${this.enabled.size} (${[...this.enabled.keys()].join(", ") || "none"})`);
  }

  enable(plugin: Plugin): void {
    if (!VALID_PLUGIN_NAME.test(plugin.name) || RESERVED_PLUGIN_NAMES.has(plugin.name.toLowerCase())) {
      logger.error(
        `Plugin name "${plugin.name}" is not allowed. Use 1-32 letters, digits, "_" or "-" (and not "core").`,
      );
      return;
    }
    if (this.enabled.has(plugin.name)) {
      logger.warn(`Plugin "${plugin.name}" is already loaded, skipping the duplicate.`);
      return;
    }
    try {
      plugin.onEnable(this.createApi(plugin));
      this.enabled.set(plugin.name, plugin);
    } catch (err) {
      // A half-enabled plugin may have registered some things already.
      this.removeRegistrations(plugin.name);
      logger.error(`Plugin "${plugin.name}" failed to enable: ${formatError(err)}`);
    }
  }

  disable(name: string): void {
    const plugin = this.enabled.get(name);
    if (!plugin) return;
    try {
      plugin.onDisable?.();
    } catch (err) {
      logger.error(`Plugin "${name}" crashed in onDisable: ${formatError(err)}`);
    }
    this.removeRegistrations(name);
    this.enabled.delete(name);
  }

  disableAll(): void {
    for (const name of [...this.enabled.keys()]) {
      this.disable(name);
    }
  }

  getEnabledNames(): string[] {
    return [...this.enabled.keys()];
  }

  private removeRegistrations(owner: string): void {
    this.events.removeAll(owner);
    this.commands.removeAll(owner);
    this.scheduler.removeAll(owner);
  }

  /** Loads every .js / .cjs file in plugins/. A file may export a Plugin or a list of them. */
  private readPluginFiles(): Plugin[] {
    if (!fs.existsSync(PLUGINS_DIR)) return [];

    const found: Plugin[] = [];
    for (const file of fs.readdirSync(PLUGINS_DIR)) {
      if (!/\.(c?js)$/.test(file)) continue;
      try {
        const exported = require(path.join(PLUGINS_DIR, file));
        found.push(...extractPlugins(exported));
      } catch (err) {
        logger.error(`Could not load plugin file ${file}: ${formatError(err)}`);
      }
    }
    return found;
  }

  /** Builds the object a plugin receives in onEnable(). */
  private createApi(plugin: Plugin): PluginApi {
    const owner = plugin.name;
    const pluginLogger: PluginLogger = {
      info: (m) => logger.info(`[${owner}] ${m}`),
      warn: (m) => logger.warn(`[${owner}] ${m}`),
      error: (m) => logger.error(`[${owner}] ${m}`),
    };
    const dataFile = path.join(DATA_DIR, `${owner}.json`);

    return {
      server: this.server,
      logger: pluginLogger,

      on: (event, handler) => this.events.on(owner, event, handler),

      registerCommand: (command) => {
        const registered = this.commands.register(owner, command);
        if (!registered) {
          pluginLogger.warn(`Command /${command.name} already exists, ignoring.`);
        }
        return registered;
      },

      runLater: (ticks, fn) => this.scheduler.runLater(owner, ticks, fn),
      runRepeating: (ticks, fn) => this.scheduler.runRepeating(owner, ticks, fn),

      loadData: <T>(fallback: T, validate?: (value: unknown) => value is T): T => {
        try {
          const value: unknown = JSON.parse(fs.readFileSync(dataFile, "utf8"));
          if (validate && !validate(value)) {
            pluginLogger.warn("Saved data has the wrong shape, using the default instead.");
            return fallback;
          }
          return value as T;
        } catch {
          return fallback; // no file yet, or it's unreadable
        }
      },
      saveData: (data) => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        writeFileAtomic(dataFile, JSON.stringify(data, null, 2));
      },
    };
  }
}

function isPlugin(value: unknown): value is Plugin {
  const p = value as Plugin;
  return !!p && typeof p.name === "string" && typeof p.version === "string" && typeof p.onEnable === "function";
}

/** Accepts module.exports = plugin, exports.plugin = ..., export default ..., or arrays of those. */
function extractPlugins(exported: any): Plugin[] {
  const candidates = [exported, exported?.default, exported?.plugin, ...Object.values(exported ?? {})];
  const plugins: Plugin[] = [];
  for (const candidate of candidates.flat()) {
    if (isPlugin(candidate) && !plugins.includes(candidate)) plugins.push(candidate);
  }
  return plugins;
}
