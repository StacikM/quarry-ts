import type { Player } from "./Player";
import { GameMode } from "./GameMode";
import type { PluginCommand } from "../plugins/types";
import { config } from "../config";
import { addOperator, removeOperator } from "./operators";

/**
 * The commands that come with the server. They are registered in the same
 * CommandRegistry that plugins use (under the owner name "core").
 * `args` are the words after the command name, e.g. "/tp Steve" -> ["Steve"].
 */
/** What players may type for each game mode: the number, a short letter(s), or the full name. */
const GAME_MODE_ALIASES: Record<string, GameMode> = {
  "0": GameMode.Survival, s: GameMode.Survival, survival: GameMode.Survival,
  "1": GameMode.Creative, c: GameMode.Creative, creative: GameMode.Creative,
  "2": GameMode.Adventure, a: GameMode.Adventure, adventure: GameMode.Adventure,
  "3": GameMode.Spectator, sp: GameMode.Spectator, spectator: GameMode.Spectator,
};

export const coreCommands: PluginCommand[] = [
  {
    name: "help",
    description: "List all commands",
    run(player) {
      player.sendMessage("Commands:", "gold");
      for (const command of player.server.plugins.commands.all()) {
        if (command.opOnly && !player.isOp) continue;
        player.sendMessage(`/${command.name} - ${command.description}`, "gray");
      }
    },
  },

  {
    name: "list",
    description: "Show who is online",
    run(player) {
      const names = player.server.getOnlinePlayers().map((p) => p.username);
      player.sendMessage(`Online (${names.length}): ${names.join(", ")}`);
    },
  },

  {
    name: "gamemode",
    usage: "/gamemode <survival|creative|adventure|spectator>  (or 0-3, or s/c/a/sp)",
    description: "Survival, creative, adventure or spectator",
    opOnly: true,
    run(player, args) {
      const mode = GAME_MODE_ALIASES[(args[0] ?? "").toLowerCase()];
      if (mode === undefined) {
        player.sendMessage(`Usage: ${this.usage}`, "red");
        return;
      }
      player.setGameMode(mode);
      player.sendMessage(`Game mode set to ${GameMode[mode]}`, "green");
    },
  },

  {
    name: "spawn",
    description: "Teleport to spawn",
    run(player) {
      const spawn = player.server.getSpawnPoint();
      player.teleport(spawn.x, spawn.y, spawn.z);
    },
  },

  {
    name: "tp",
    usage: "/tp <player>",
    description: "Teleport to another player",
    opOnly: true,
    run(player, args) {
      const target = args[0] ? player.server.getPlayerByName(args[0]) : undefined;
      if (!target) {
        player.sendMessage(`Usage: ${this.usage} (player must be online)`, "red");
        return;
      }
      player.teleport(target.x, target.y, target.z);
      player.sendMessage(`Teleported to ${target.username}`, "green");
    },
  },

  {
    name: "op",
    usage: "/op <player name>",
    description: "Make a player an operator",
    opOnly: true,
    run(player, args) {
      const result = args.length === 1 ? addOperator(args[0]) : "invalid";
      if (result === "invalid") player.sendMessage(`Usage: ${this.usage} (a valid Minecraft name)`, "red");
      else if (result === "already") player.sendMessage(`${args[0]} is already an operator.`, "yellow");
      else {
        player.sendMessage(`${args[0]} is now an operator.`, "green");
        player.server.getPlayerByName(args[0])?.sendMessage("You are now an operator.", "yellow");
      }
    },
  },

  {
    name: "deop",
    usage: "/deop <player name>",
    description: "Remove a player's operator status",
    opOnly: true,
    run(player, args) {
      if (args.length !== 1) {
        player.sendMessage(`Usage: ${this.usage}`, "red");
        return;
      }
      if (removeOperator(args[0]) === "not-an-operator") player.sendMessage(`${args[0]} is not an operator.`, "yellow");
      else {
        player.sendMessage(`${args[0]} is no longer an operator.`, "green");
        player.server.getPlayerByName(args[0])?.sendMessage("You are no longer an operator.", "yellow");
      }
    },
  },

  {
    name: "plugins",
    description: "List enabled plugins",
    run(player) {
      const names = player.server.plugins.getEnabledNames();
      player.sendMessage(`Plugins (${names.length}): ${names.join(", ") || "none"}`);
    },
  },

  {
    name: "seed",
    description: "Show the world seed",
    run(player) {
      player.sendMessage(`Seed: ${config.seed} (generator: ${player.server.world.generator.name})`);
    },
  },
];

/** Called for every chat message that starts with "/". */
export function runCommand(player: Player, input: string): void {
  const [name, ...args] = input.split(/\s+/);

  // Plugins can see (and cancel or rewrite) a command before it runs.
  const event = player.server.plugins.events.emit("playerCommand", {
    player,
    command: name.toLowerCase(),
    args,
    cancelled: false,
  });
  if (event.cancelled) return;

  const command = player.server.plugins.commands.get(event.command);
  if (!command) {
    player.sendMessage("Unknown command. Type /help for a list.", "red");
    return;
  }
  if (command.opOnly && !player.isOp) {
    player.sendMessage("You don't have permission to use that command.", "red");
    return;
  }

  try {
    command.run(player, event.args);
  } catch (err) {
    player.sendMessage("That command crashed. Check the server console.", "red");
    console.error(`/${command.name} crashed:`, err);
  }
}
