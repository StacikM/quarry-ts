import type { CommandSender, PluginCommand } from "../plugins/types";

/**
 * A command that works the same whether a player or the server console runs it.
 * It only needs `sender.sendMessage`, `sender.name`, `sender.server` and `sender.isOp`.
 */
export interface SenderCommand {
  name: string;
  description: string;
  usage?: string;
  opOnly?: boolean;
  run(sender: CommandSender, args: string[]): void;
}

/** Turns a SenderCommand into a normal command that players AND the console can run. */
export function senderCommand(spec: SenderCommand): PluginCommand {
  return {
    name: spec.name,
    description: spec.description,
    usage: spec.usage,
    opOnly: spec.opOnly,
    run: (player, args) => spec.run(player, args),
    runConsole: (sender, args) => spec.run(sender, args),
  };
}

/** Colour codes for messages. They work in game and are removed for the console. */
export const colour = {
  red: "\u00a7c",
  green: "\u00a7a",
  yellow: "\u00a7e",
  gold: "\u00a76",
  gray: "\u00a77",
  white: "\u00a7f",
  aqua: "\u00a7b",
};

export function sendUsage(sender: CommandSender, usage: string): void {
  sender.sendMessage(`Usage: ${usage}`, "red");
}
