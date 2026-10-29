import type { Player } from "./Player";
import { GameMode } from "./GameMode";
import type { PluginCommand } from "../plugins/types";
import { config } from "../config";

/**
 * The commands that come with the server. They are registered in the same
 * CommandRegistry that plugins use (under the owner name "core").
 * `args` are the words after the command name, e.g. "/tp Steve" -> ["Steve"].
 */
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
    usage: "/gamemode <0|1|2|3>",
    description: "Survival, creative, adventure or spectator",
    opOnly: true,
    run(player, args) {
      const mode = Number(args[0]);
      if (!args[0] || !(mode in GameMode)) {
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
