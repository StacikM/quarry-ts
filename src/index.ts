import readline from "node:readline";
import { MinecraftServer } from "./game/Server";
import { logger } from "./util/logger";

/**
 * Entry point. Starts the server and lets you type in the console:
 *   stop         -> saves the world and shuts the server down
 *   stop force   -> shuts down even if some changes could not be saved
 *   save         -> saves the world right now
 *   anything     -> sent to everyone as a [Server] chat message
 */
logger.info("Quarry.ts: Minecraft 1.8.9 server");
const server = new MinecraftServer();
server.start();

const consoleInput = readline.createInterface({ input: process.stdin });

consoleInput.on("line", (line) => {
  const text = line.trim();
  if (text === "stop") {
    shutdown(false);
  } else if (text === "stop force") {
    shutdown(true);
  } else if (text === "save") {
    const { failed } = server.saveWorld({ quiet: false });
    if (failed > 0) logger.error(`${failed} chunk(s) could not be saved.`);
  } else if (text.length > 0) {
    server.broadcastMessage(`[Server] ${text}`, "light_purple");
  }
});

let stopping = false;

/**
 * Stops the server, but never exits while player changes exist only in
 * memory. If saving fails (disk full, folder not writable...) the server stays
 * up so you can fix the problem and run "stop" again to retry.
 */
function shutdown(force: boolean): void {
  if (!stopping) {
    stopping = true;
    server.stop();
  }

  const { failed } = server.saveWorld({ quiet: false });
  if (failed > 0 && !force) {
    logger.error(
      `${failed} chunk(s) could NOT be saved, so the process is staying open. ` +
        `Fix the problem, then type "stop" to try again, or "stop force" (or press Ctrl+C again) to quit and LOSE those changes.`,
    );
    return;
  }
  if (failed > 0) {
    logger.error(`Exiting anyway: changes in ${failed} chunk(s) were lost.`);
  }

  consoleInput.close();
  // Give the kick messages a moment to reach the clients.
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 200);
}

// Ctrl+C. Pressing it a second time while we are already stopping means "force".
process.on("SIGINT", () => shutdown(stopping));

logger.info("Type 'stop' to shut down.");
