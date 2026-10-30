# 4. Timers and saved data

[Back to the index](README.md)

## Timers

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

Data files belong to the plugin name, so choose a name nobody else uses. A plugin that reads a file you did not write (like the built-in `npcs` plugin) should refuse to start rather than overwrite a file it cannot read.
