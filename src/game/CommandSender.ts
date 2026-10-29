import type { CommandSender } from "../plugins/types";
import type { MinecraftServer } from "./Server";
import { logger } from "../util/logger";

/** Removes Minecraft colour codes ("§a", "§r"...), which mean nothing in a terminal. */
export function stripColorCodes(text: string): string {
  return text.replace(/\u00a7./g, "");
}

/**
 * The server console as someone who can run commands. Replies are printed to
 * the terminal. The console is always an operator.
 */
export class ConsoleSender implements CommandSender {
  constructor(readonly server: MinecraftServer) {}

  readonly name = "Console";
  readonly isOp = true;
  readonly isConsole = true;

  sendMessage(text: string): void {
    for (const line of stripColorCodes(text).split("\n")) {
      logger.info(line);
    }
  }
}
