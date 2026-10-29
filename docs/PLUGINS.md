# Writing plugins

Put a CommonJS `.js` or `.cjs` file in `plugins/`, next to the directory where you start the server, then restart. Plugins run in the server's Node.js process and have normal JavaScript access. The examples below are complete plugin files; choose unique names if you combine them.

## Minimal plugin

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

Names contain 1–32 letters, digits, `_`, or `-`; `core` is reserved. Prefer lowercase names, including distinct spelling rather than only different case. A plugin can also define `onDisable()`. List loaded names with `/plugins`. The TypeScript contract is `src/plugins/types.ts`; builtins are working examples in `src/plugins/builtin/`.

## Events

Subscribe with `api.on(eventName, handler)`. Handlers run synchronously in registration order and receive the same mutable event object. Check `event.cancelled` before performing an optional side effect, and leave a previous cancellation intact. Cancellation does not skip the remaining handlers.

| Event | Fields | Timing and cancellation |
| --- | --- | --- |
| `playerJoin` | `player` | Player is online and initial chunks have been sent. Cannot cancel. |
| `playerQuit` | `player` | Player has been removed from the online list. Cannot cancel. |
| `playerChat` | `player`, `message`, `format`, `cancelled` | Before broadcast. Cancel to suppress the line; edit `message` for filtering or `format` for appearance. |
| `playerCommand` | `player`, `command`, `args`, `cancelled` | Before lookup and permission checks. `command` excludes `/`; `args` is a string array. Cancel to stop execution, or rewrite these fields to redirect it. Permission checks apply to the resulting command. |
| `playerMove` | `player`, `from: {x,y,z}` | After a position packet is applied and chunks updated. `player.x/y/z` are the new coordinates. Cannot cancel. Look-only packets and `player.teleport()` do not emit it. |
| `blockBreak` | `player`, `position: {x,y,z}`, `blockId`, `cancelled` | Before removing the block. Cancel to keep it; the server restores the client's predicted block. |
| `blockPlace` | `player`, `position: {x,y,z}`, `blockId`, `metadata`, `cancelled` | Before placing at the target position, which is next to the clicked face. Cancel to deny placement and correct the client. |

Block positions use integer world coordinates. Treat block event positions, IDs and metadata as context; the supported control is cancellation. In particular, editing placement `blockId` or `metadata` does not currently change what the core places. Use `api.server.setBlock(position, id, metadata)` to persist a world edit and send it to nearby clients. The lower-level `api.server.world.setBlock()` persists the edit without sending a block update. Terrain generators' `chunk.setBlock()` is deliberately unsaved.

Keep coordinates for later tasks rather than holding a `Chunk`: autosave may unload an unneeded chunk, leaving a saved reference detached. Resolve the world/chunk again when the task runs.

Incoming chat has section signs/control characters removed and is limited to 100 characters. Plugins can add trusted colour codes to `format`. The default template is `<{player}> {message}`. Substitution happens once, after all handlers and the cancellation check: `{player}` typed inside a message stays literal. Never broadcast from a chat listener; that would bypass later moderation.

## Commands and operator permissions

`api.registerCommand()` returns `false` if a case-insensitive name is already registered. The first command wins, including core commands. Throw during enable if your plugin needs a command that it could not register; the manager removes its partial registrations. `usage` is descriptive text: your handler validates arguments and sends usage messages itself.

```js
module.exports = {
  name: "guide-notice",
  version: "1.0.0",
  onEnable(api) {
    const registered = api.registerCommand({
      name: "notice",
      description: "Broadcast an operator notice",
      usage: "/notice <message>",
      opOnly: true,
      run(player, args) {
        if (!args.length) { player.sendMessage("Usage: /notice <message>", "red"); return; }
        api.server.broadcastMessage(`[Notice] ${args.join(" ")}`, "gold");
      },
    });
    if (!registered) throw new Error("/notice is already registered");
  },
};
```

`opOnly` checks `player.isOp`, based on the case-insensitive names in `config.ops`. Omit it for a public command. `/help` lists public commands and hides operator commands from non-operators. These permissions do not authenticate usernames: this server currently runs in offline mode.

## Scheduler

`api.runLater(ticks, fn)` runs once; `api.runRepeating(ticks, fn)` repeats until disable. Use positive integer ticks: nominally 20 ticks are one second, and lag may make the interval longer. There is currently no per-task cancel handle. All tasks registered through the API are cancelled automatically on plugin disable.

```js
module.exports = {
  name: "guide-timers",
  version: "1.0.0",
  onEnable(api) {
    api.on("playerJoin", ({ player }) => {
      const name = player.username, uuid = player.uuid;
      api.runLater(40, () => {
        const online = api.server.getPlayerByName(name);
        if (online && online.uuid === uuid) online.sendMessage("Try /help for commands.", "aqua");
      });
    });
    api.runRepeating(1200, () => api.server.broadcastMessage("Use /rules to read the rules.", "gray"));
  },
};
```

Resolve the online player again in a delayed callback. A timer can outlive the connection that scheduled it. The delayed greeting above applies if the same identity is online when it fires, including a reconnect.

## Saving small amounts of data

`api.loadData(fallback, validate)` reads `plugins-data/<plugin-name>.json`. Missing, unreadable, malformed, or validator-rejected data uses the fallback. TypeScript types alone do not validate JSON. Save plain JSON values, not `Player`, `Chunk`, `Map`, or server objects. `saveData()` writes a temporary file and renames it over the old file; it can throw on disk errors. This provides atomic file replacement, without a power-loss durability guarantee.

```js
module.exports = {
  name: "guide-visits",
  version: "1.0.0",
  onEnable(api) {
    const valid = (value) => value !== null && typeof value === "object"
      && !Array.isArray(value) && Number.isSafeInteger(value.visits) && value.visits >= 0;
    let data = api.loadData({ visits: 0 }, valid);
    api.on("playerJoin", ({ player }) => {
      const next = { visits: data.visits + 1 };
      api.saveData(next);
      data = next;
      player.sendMessage(`Server visits: ${data.visits}`, "gold");
    });
  },
};
```

The next state is saved before replacing the in-memory state, so a failed write does not report a successful update. For homes/warps, validate finite coordinates and copy `{x,y,z}` rather than storing the entire player object. Player UUIDs and names in offline mode are not verified account identities.

## Recipe: protect an area

This example protects a 24-block horizontal radius around the configured spawn, at all heights. It respects existing cancellations and allows operators to build.

```js
module.exports = {
  name: "guide-protection",
  version: "1.0.0",
  onEnable(api) {
    const spawn = api.server.getSpawnPoint();
    const protect = (event) => {
      if (event.cancelled || event.player.isOp) return;
      const dx = event.position.x + 0.5 - spawn.x;
      const dz = event.position.z + 0.5 - spawn.z;
      if (Math.hypot(dx, dz) <= 24) {
        event.cancelled = true;
        event.player.sendMessage("This area is protected.", "yellow");
      }
    };
    api.on("blockBreak", protect);
    api.on("blockPlace", protect);
  },
};
```

The bundled spawn-protection plugin already protects 16 blocks. A second plugin can add protection; it cannot override an earlier cancellation simply by returning from its own handler.

## Recipe: rank-prefixed chat

```js
module.exports = {
  name: "guide-ranks",
  version: "1.0.0",
  onEnable(api) {
    api.on("playerChat", (event) => {
      if (event.cancelled) return;
      const rank = event.player.isOp ? "\u00a7c[Admin]" : "\u00a77[Member]";
      event.format = `${rank} \u00a7f<{player}> \u00a77{message}`;
    });
  },
};
```

This external plugin loads after builtin chat formatting, so its template takes precedence. Later plugins can still filter `message` or cancel the line. Changing the template does not send anything by itself.

## Recipe: teleport command with a cooldown

`/visit <player>` teleports to an online player, with ten server seconds between successful uses. The cooldown remains across reconnects for that identity until its scheduled expiry, and is cleared when the plugin is re-enabled or the server restarts.

```js
module.exports = {
  name: "guide-visit",
  version: "1.0.0",
  onEnable(api) {
    const coolingDown = new Set();
    const registered = api.registerCommand({
      name: "visit",
      description: "Visit another player (10-second cooldown)",
      usage: "/visit <player>",
      run(player, args) {
        if (coolingDown.has(player.uuid)) { player.sendMessage("Wait before using /visit again.", "red"); return; }
        const target = args.length === 1 ? api.server.getPlayerByName(args[0]) : undefined;
        if (!target) { player.sendMessage("Usage: /visit <online player>", "red"); return; }
        player.teleport(target.x, target.y, target.z);
        const uuid = player.uuid;
        coolingDown.add(uuid);
        api.runLater(200, () => coolingDown.delete(uuid));
        player.sendMessage(`Visited ${target.username}.`, "green");
      },
    });
    if (!registered) throw new Error("/visit is already registered");
  },
};
```

## Load order, cleanup and errors

Core commands register first. Builtin plugins enable next, followed by `.js`/`.cjs` files from `plugins/`. There is no dependency or priority API; avoid relying on file enumeration order between external plugins. A file may export one plugin, an array, `exports.plugin`, or a default export. Restart to pick up file changes; there is no reload command.

On disable, API listeners, commands and scheduled tasks are removed automatically. Use `onDisable()` to release resources you created outside the API, such as your own sockets or timers. A failed `onEnable()` also removes partial API registrations. Plugin data remains on disk after disable.

Synchronous listener and scheduler exceptions are logged without stopping subsequent handlers/tasks. Command exceptions send the caller an error and log details. Failed enable and disable hooks are logged. This is exception isolation, not a separate process: avoid blocking work and handle asynchronous promise rejections yourself. The APIs expect synchronous callbacks; returning a rejected promise is outside those synchronous catch blocks. Side effects already performed before an exception are not rolled back.

## Checking the examples

Every JavaScript block in this guide is extracted and run by `npx tsx scripts/plugin-docs-check.ts`. It enables each plugin through the real manager in a temporary directory, exercises its behavior, and checks persistence, operator permissions, cooldown expiry, moderation order, and timer cleanup. The existing suites are `npm run check`; run the guide checker after editing examples too.
