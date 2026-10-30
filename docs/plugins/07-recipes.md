# 7. Recipes

[Back to the index](README.md)

## Protect an area

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

The bundled spawn-protection plugin already protects 16 blocks. A second plugin can add protection; it cannot override an earlier cancellation simply by returning from its own handler. For a whole lobby, set `protectWorld` in `server.json` instead: only operators can build and everybody else joins in adventure mode.

## Rank-prefixed chat

```js
module.exports = {
  name: "guide-ranks",
  version: "1.0.0",
  onEnable(api) {
    api.on("playerChat", (event) => {
      if (event.cancelled) return;
      const rank = event.player.isOp ? "§c[Admin]" : "§7[Member]";
      event.format = `${rank} §f<{player}> §7{message}`;
    });
  },
};
```

This external plugin loads after builtin chat formatting, so its template takes precedence. Later plugins can still filter `message` or cancel the line. Changing the template does not send anything by itself.

## A teleport command with a cooldown

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
