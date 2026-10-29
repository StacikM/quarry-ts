import type { MinecraftServer } from "./game/Server";
import { addOperator, listOperators, removeOperator } from "./game/operators";
import { formatError, logger } from "./util/logger";

/**
 * Commands you type into the server console (the terminal running the server).
 * `stop` and `stop force` are handled in index.ts because they end the process.
 *
 * Anything that is not a command is NOT sent to players: a typo should not
 * become a public chat message. Use `say` to talk to everyone.
 */
export function runConsoleCommand(server: MinecraftServer, line: string): void {
  const [command, ...args] = line.trim().split(/\s+/);
  const rest = args.join(" ");

  switch (command.toLowerCase()) {
    case "": // an empty line
      return;

    case "help":
      logger.info("Console commands: say <message>, op <name>, deop <name>, ops, list, save, stop, stop force");
      return;

    case "say":
      if (!rest) logger.warn("Usage: say <message>");
      else server.broadcastMessage(`[Server] ${rest}`, "light_purple");
      return;

    case "list": {
      const names = server.getOnlinePlayers().map((player) => player.username);
      logger.info(`Online (${names.length}): ${names.join(", ") || "nobody"}`);
      return;
    }

    case "ops":
      logger.info(`Operators: ${listOperators().join(", ") || "nobody"}`);
      return;

    case "op":
      return changeOperator(server, args, "op");

    case "deop":
      return changeOperator(server, args, "deop");

    case "save": {
      const { failed } = server.saveWorld({ quiet: false });
      if (failed > 0) logger.error(`${failed} chunk(s) could not be saved.`);
      return;
    }

    default:
      logger.warn(`Unknown command "${command}". Type help for a list. (To talk to players, use: say <message>)`);
  }
}

function changeOperator(server: MinecraftServer, args: string[], action: "op" | "deop"): void {
  if (args.length !== 1) {
    logger.warn(`Usage: ${action} <player name>`);
    return;
  }
  const name = args[0];

  try {
    if (action === "op") {
      const result = addOperator(name);
      if (result === "invalid") logger.warn(`"${name}" is not a valid Minecraft name (1-16 letters, digits or _).`);
      else if (result === "already") logger.info(`${name} is already an operator.`);
      else {
        logger.info(`${name} is now an operator.`);
        server.getPlayerByName(name)?.sendMessage("You are now an operator.", "yellow");
      }
    } else {
      const result = removeOperator(name);
      if (result === "not-an-operator") logger.info(`${name} is not an operator.`);
      else {
        logger.info(`${name} is no longer an operator.`);
        server.getPlayerByName(name)?.sendMessage("You are no longer an operator.", "yellow");
      }
    }
  } catch (err) {
    // ops.json could not be written (disk full, no permission...). Nothing was changed.
    logger.error(`Could not save ops.json, so the operator list was not changed: ${formatError(err)}`);
  }
}
