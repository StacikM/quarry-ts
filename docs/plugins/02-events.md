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
| `npcInteract` | `player`, `npc`, `click: "left" \| "right"`, `sneaking` | A player hit (`left`) or right-clicked (`right`) an NPC, once per click and only with the main hand. Spectators are ignored. Cannot cancel. See [NPCs](06-npcs.md). |

## Blocks

Block positions use integer world coordinates. Each `state` is a Java 1.21.11 block-state number, including its properties; there is no separate block ID/metadata pair. Treat event positions and states as context: the supported control is cancellation, and changing placement `state` does not change what the core places. Use `api.server.setBlock(position, state)` to persist a world edit and send it to nearby clients. The lower-level `api.server.world.setBlock()` persists the edit without sending a block update. Read with `api.server.world.getState(position)` or `chunk.getState(x, y, z)`. Terrain generators' `chunk.setBlock(x, y, z, state)` is deliberately unsaved. TypeScript code can use `stateOf("oak_log", { axis: "y" })` and `describeState(state)` from `src/world/blockStates.ts` to convert names and properties.

Blocks that need support (plants, torches, ladders, doors, carpets) break by themselves when the block under or behind them is broken, and they are refused where they could not stay. `api.server.setBlock()` does not do that for you: it places exactly what you ask.

Keep coordinates for later tasks rather than holding a `Chunk`: autosave may unload an unneeded chunk, leaving a saved reference detached. Resolve the world/chunk again when the task runs.

## Chat

Incoming chat has section signs/control characters removed and is limited to 100 characters. Plugins can add trusted colour codes to `format`. The default template is `<{player}> {message}`. Substitution happens once, after all handlers and the cancellation check: `{player}` typed inside a message stays literal. Never broadcast from a chat listener; that would bypass later moderation.
