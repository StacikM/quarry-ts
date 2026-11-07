# 2. Events

[Back to the index](README.md)

Subscribe with `api.on(eventName, handler)`. Handlers run synchronously in registration order and receive the same mutable event object. Check `event.cancelled` before performing an optional side effect, and leave a previous cancellation intact. Cancellation does not skip the remaining handlers.

| Event | Fields | Timing and cancellation |
| --- | --- | --- |
| `playerJoin` | `player` | Player is online and initial chunks have been sent. Cannot cancel. |
| `playerQuit` | `player` | Player has been removed from the online list. Cannot cancel. |
| `playerChat` | `player`, `message`, `format`, `cancelled` | Before broadcast. Cancel to suppress the line; edit `message` for filtering or `format` for appearance. |
| `playerCommand` | `player`, `command`, `args`, `cancelled` | Before lookup and permission checks. `command` excludes `/`; `args` is a string array. Cancel to stop execution, or rewrite these fields to redirect it. Permission checks apply to the resulting command. |
| `playerMove` | `player`, `from: {x,y,z}` | After a position packet is applied and chunks updated. `player.x/y/z` are the new coordinates. Cannot cancel. Look-only packets and `player.teleport()` do not emit it. |
| `blockBreak` | `player`, `position: {x,y,z}`, `state`, `cancelled` | Before removing the block. Cancel to keep it; the server restores the client's predicted block. |
| `blockPlace` | `player`, `position: {x,y,z}`, `state`, `cancelled` | Before placing at the target position, which is next to the clicked face. Cancel to deny placement and correct the client. |
| `playerInteract` | `player`, `position`, `face`, `click: "left" | "right"`, `item`, `cancelled` | A player left-clicked (started digging) or right-clicked a block with the main hand. `item` is the name of the item in hand, such as `wooden_axe`, or `undefined`. Cancel to stop the break, placement or door; the client is corrected. It comes before `blockBreak` and `blockPlace`. Spectators are ignored. |
| `playerDamage` | `player`, `attacker?`, `damage`, `cause`, `cancelled` | Before a player loses health. `damage` is what is left after armor. Cancel to take no damage; change `damage` to hurt more or less. With `"pvp": false` in config.json, damage from another player arrives already cancelled, and a plugin may set `cancelled = false` to allow it (a duel arena does this). |
| `playerDeath` | `player`, `killer?`, `cause`, `message`, `cancelled` | The damage would kill the player (or `player.kill()` was called). Cancel to keep them alive (a duel plugin ends the match instead). `message` is the sentence everybody reads, "Bob was slain by Alice": change it, or set `null` to say nothing. `cause` is `melee`, `arrow`, `explosion`, `void`, `kill` or what a plugin gave to `combat.damage()`. |
| `playerRespawn` | `player`, `position: {x,y,z,yaw?,pitch?}`, `keepInventory` | A dead player is coming back (they pressed Respawn, or `player.respawn()` was called). Change `position` to choose where they appear (the world spawn by default) and `keepInventory` to choose whether they keep their items (config.json decides by default). It cannot be cancelled. |
| `playerRespawned` | `player` | The respawn is finished: they are alive, at the new place, and everybody has been told. A good moment to hand out starting items. |
| `explosion` | `position: {x,y,z}`, `power`, `blocks: {x,y,z}[]`, `cancelled` | Before an explosion (lit TNT, or a plugin calling `api.server.explosions.explode(x, y, z, power)`) changes anything. `blocks` are the blocks it will destroy: assign a shorter list to protect some, or cancel to stop the whole explosion (no blocks, no sound, nobody thrown). |
| `npcInteract` | `player`, `npc`, `click: "left" \| "right"`, `sneaking` | A player hit (`left`) or right-clicked (`right`) an NPC, once per click and only with the main hand. Spectators are ignored. Cannot cancel. See [NPCs](06-npcs.md). |

## Blocks

Block positions use integer world coordinates. Each `state` is a Java 1.21.11 block-state number, including its properties; there is no separate block ID/metadata pair. Treat event positions and states as context: the supported control is cancellation, and changing placement `state` does not change what the core places. Use `api.server.setBlock(position, state)` to persist a world edit and send it to nearby clients, or `api.server.setBlocks([{ x, y, z, state }, ...])` for many blocks (one packet per 16x16x16 section). The lower-level `api.server.world.setBlock()` persists the edit without sending a block update. Read with `api.server.world.getState(position)` or `chunk.getState(x, y, z)`. Terrain generators' `chunk.setBlock(x, y, z, state)` is deliberately unsaved. TypeScript code can use `stateOf("oak_log", { axis: "y" })` and `describeState(state)` from `src/world/blockStates.ts` to convert names and properties.

Blocks that need support (plants, torches, ladders, doors, carpets) break by themselves when the block under or behind them is broken, and they are refused where they could not stay. `api.server.setBlock()` does not do that for you: it places exactly what you ask.

Keep coordinates for later tasks rather than holding a `Chunk`: autosave may unload an unneeded chunk, leaving a saved reference detached. Resolve the world/chunk again when the task runs.

## Chat

Incoming chat has section signs/control characters removed and is limited to 100 characters. Plugins can add trusted colour codes to `format`. The default template is `<{player}> {message}`. Substitution happens once, after all handlers and the cancellation check: `{player}` typed inside a message stays literal. Never broadcast from a chat listener; that would bypass later moderation.
