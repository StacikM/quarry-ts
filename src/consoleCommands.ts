import type { MinecraftServer } from "./game/Server";
import { formatError, logger } from "./util/logger";

/**
 * Commands you type into the server console (the terminal running the server).
 * `stop` and `stop force` are handled in index.ts because they end the process.
 *
 * Every other command is looked up in the SAME command list that players use,
 * so /kick, /ban, /tps, /op and so on work identically here. Commands that
 * need a player (like /tp) are game only. The leading "/" is optional.
 *
 * Anything that is not a command is NOT sent to players: a typo should not
 * become a public chat message. Use `say` to talk to everyone.
 */
export function runConsoleCommand(server: MinecraftServer, line: string): void {
  const [rawName, ...args] = line.trim().split(/\s+/);
  const name = rawName.replace(/^\//, "").toLowerCase();
  if (!name) return; // an empty line

  const command = server.plugins.commands.get(name);
  if (!command) {
    logger.warn(`Unknown command "${name}". Type help for a list. (To talk to players, use: say <message>)`);
    return;
  }
  if (!command.runConsole) {
    logger.warn(`"${name}" can only be used in game.`);
    return;
  }

  try {
    command.runConsole(server.console, args);
  } catch (err) {
    logger.error(`${name} crashed: ${formatError(err)}`);
  }
}
