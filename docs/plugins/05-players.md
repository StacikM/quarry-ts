# 5. Players

[Back to the index](README.md)

Everything about one online player is on the `Player` object that events and commands give you. Find players with `api.server.getPlayerByName(name)` and `api.server.getOnlinePlayers()`. Do not keep a `Player` for later: resolve it again by name or UUID when a timer fires (see [Timers](04-scheduler-and-data.md)).

## What you can read

| Property | Meaning |
| --- | --- |
| `username`, `uuid` | Who they are. In offline mode these are not verified accounts; behind a Velocity proxy they are. |
| `x`, `y`, `z`, `yaw`, `pitch` | Where they are and which way they look. Yaw 0 faces south, 90 west, 180 north, 270 east. |
| `gameMode` | 0 survival, 1 creative, 2 adventure, 3 spectator. |
| `isOp` | Whether their name is in `ops.json`. |
| `ip` | Their real address (the proxy's forwarded one behind Velocity). |
| `properties` | Profile properties, including the signed skin when a proxy supplied one. |
| `skinParts` | Which skin layers they show (hat, jacket, sleeves, pants, cape) as a bit set. |

## What you can do

| Method | Behavior |
| --- | --- |
| `player.sendMessage(text, color?)` | A chat line only they see. `§` colour codes work. |
| `player.sendActionBar(text, color?)` | Show text above the hotbar. |
| `player.sendTitle(title, subtitle?, options?)` | Show a title and optional subtitle. Options are `color`, `fadeIn`, `stay`, and `fadeOut`; durations are ticks (20 per second), defaulting to 10, 70, and 20. |
| `player.clearTitle()` | Clear the current title. |
| `player.teleport(x, y, z)` | Move them. |
| `player.setGameMode(mode)` | Change their game mode (0 to 3). |
| `player.give(item, count?)` | Put items in their inventory, hotbar first. `item` is a name such as `"diamond_sword"` or `"minecraft:diamond_sword"`. Returns how many did not fit, and throws for an unknown name or a count outside 1 to 2304. |
| `player.selectHotbarSlot(slot)` | Select hotbar slot 0 to 8 on their screen. |
| `player.kick(reason)` | Disconnect them with a message. |
| `player.isDead` | True from the moment they die until they respawn. A dead player cannot move, break blocks or click, only chat and press Respawn. |
| `player.kill(cause?)` | Kill them on purpose (any game mode, armor does not help). The `playerDeath` event can still cancel it. Returns false if it did not happen. |
| `player.respawn()` | Bring a dead player back now, without waiting for the Respawn button (so a plugin can skip the death screen). Returns false if they are not dead. |
| `player.connectToServer(serverName)` | Ask the connected Velocity/BungeeCord proxy to transfer the player to a configured backend name. Direct connections have no proxy to handle the request. Names must contain 1–64 letters, digits, `_`, `.`, or `-`. |

A proxy transfer requires the proxy's plugin-message support as well as its backend configuration; this method does not open a direct connection from the client.

## Death and respawn

A player whose health reaches 0 sees the death screen, the others see them fall over, and everybody reads how it happened. When the player presses Respawn they come back at the world spawn with full health. `config.json` decides the defaults: `"pvp"` (can players hurt each other), and `"respawn": { "immediate", "keepInventory", "deathMessages" }`. Plugins can override each death and each respawn with the events `playerDeath`, `playerRespawn` and `playerRespawned` (see [Events](02-events.md)). This example sends players back to a lobby area without their items and writes its own death message:

```js
module.exports = {
  name: "guide-respawn",
  version: "1.0.0",
  onEnable(api) {
    api.on("playerRespawn", (event) => {
      event.position = { x: 100.5, y: 70, z: 100.5, yaw: 90, pitch: 0 };
      event.keepInventory = false;
    });
    api.on("playerRespawned", ({ player }) => player.sendMessage("Welcome back!", "green"));
    api.on("playerDeath", (event) => {
      if (event.killer) event.message = event.killer.username + " got " + event.player.username + "!";
    });
  },
};
```

## Inventory

The server tracks what each player carries: items and counts only, not names, enchantments or other item data. Creative players' inventory changes are read from the client, `/give` and `player.give()` fill the hotbar first and then the main part, and stack sizes are the real ones (a sword does not stack, an ender pearl stacks to 16). Survival inventory clicks are not handled yet, so use this for creative and adventure servers such as lobbies.

Middle click (pick block) selects the block's item if it is in the hotbar, and in creative mode gives it otherwise.
