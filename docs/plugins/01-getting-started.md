# 1. Getting started

[Back to the index](README.md)

## A minimal plugin

```js
module.exports = {
  name: "guide-hello",
  version: "1.0.0",
  onEnable(api) {
    api.registerCommand({
      name: "guidehello",
      description: "Say hello",
      run(player) { player.sendMessage(`Hello, ${player.username}!`, "green"); },
    });
  },
};
```

Names contain 1–32 letters, digits, `_`, or `-`; `core` is reserved. Prefer lowercase names, including distinct spelling rather than only different case. A plugin can also define `onDisable()`. List loaded names with `/plugins`.

## What `api` gives you

| Member | What it is | Page |
| --- | --- | --- |
| `api.on(event, handler)` | Listen to an event | [Events](02-events.md) |
| `api.registerCommand(command)` | Add a `/command` | [Commands](03-commands.md) |
| `api.runLater(ticks, fn)`, `api.runRepeating(ticks, fn)` | Timers | [Timers and saved data](04-scheduler-and-data.md) |
| `api.loadData(fallback, validate)`, `api.saveData(data)` | A small JSON file for your plugin | [Timers and saved data](04-scheduler-and-data.md) |
| `api.npcs` | Fake players | [NPCs](06-npcs.md) |
| `api.server` | The running server: players, world, `setBlock`, `broadcastMessage` | [Players](05-players.md) |
| `api.logger` | `info`, `warn` and `error`, prefixed with your plugin name | |

## Load order, cleanup and errors

Core commands register first. Builtin plugins enable next, followed by `.js`/`.cjs` files from `plugins/`. There is no dependency or priority API; avoid relying on file enumeration order between external plugins. A file may export one plugin, an array, `exports.plugin`, or a default export. Restart to pick up file changes; there is no reload command.

On disable, API listeners, commands, scheduled tasks and NPCs are removed automatically. Use `onDisable()` to release resources you created outside the API, such as your own sockets or timers. A failed `onEnable()` also removes partial API registrations. Plugin data remains on disk after disable.

Synchronous listener and scheduler exceptions are logged without stopping subsequent handlers/tasks. Command exceptions send the caller an error and log details. Failed enable and disable hooks are logged. This is exception isolation, not a separate process: avoid blocking work and handle asynchronous promise rejections yourself. The APIs expect synchronous callbacks; returning a rejected promise is outside those synchronous catch blocks. Side effects already performed before an exception are not rolled back.
