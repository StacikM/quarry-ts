/**
 * Example plugin written in plain JavaScript. Drop any .js file like this
 * into the plugins/ folder and restart the server.
 *
 * It shows the four main things a plugin can do: listen to events,
 * cancel/modify them, add commands, and schedule work.
 */
module.exports = {
  name: "example",
  version: "1.0.0",

  onEnable(api) {
    // 1. Listen to an event.
    api.on("playerJoin", ({ player }) => {
      // 2. Do something later: 40 ticks = 2 seconds.
      api.runLater(40, () => player.sendMessage(`Welcome, ${player.username}! Try /hello`, "aqua"));
    });

    // 3. Change or cancel an event.
    api.on("playerChat", (event) => {
      if (event.message.toLowerCase().includes("badword")) {
        event.cancelled = true;
        event.player.sendMessage("Please keep chat friendly.", "red");
      }
    });

    // 4. Protect a spot: nobody can break the block under spawn.
    api.on("blockBreak", (event) => {
      if (event.position.x === 0 && event.position.z === 0) {
        event.cancelled = true;
      }
    });

    // 5. Add a command.
    api.registerCommand({
      name: "hello",
      description: "Say hello",
      run(player) {
        player.sendMessage(`Hello ${player.username}, you are at ${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)}`, "green");
      },
    });

    api.logger.info("example plugin ready");
  },
};
