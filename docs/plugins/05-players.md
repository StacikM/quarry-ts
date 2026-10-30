# 5. Players

[Back to the index](README.md)

Events and commands give you a Player. Find online players with `api.server.getPlayerByName(name)` or `getOnlinePlayers()`; resolve them again when delayed work runs rather than keeping an old connection.

| Property | Meaning |
| --- | --- |
| `username`, `uuid` | The supplied name and offline UUID. Neither authenticates an account. |
| `name`, `isConsole` | Command-sender compatibility; a Player's isConsole is false. |
| `x`, `y`, `z`, `yaw`, `pitch`, `onGround` | Position, angles and reported ground state. Yaw 0 faces south, 90 west, 180 north, 270 east. |
| `gameMode` | 0 survival, 1 creative, 2 adventure, 3 spectator. |
| `isOp` | Case-insensitive membership in the configured operator names. |
| `ip` | Normalized socket address. No modern proxy identity forwarding is implemented here. |
| `server` | The running server, including players, world, broadcasts and persistent setBlock. |

| Method | Behavior |
| --- | --- |
| `sendMessage(text, color?)` | Send chat to this player; section-sign colors work. |
| `teleport(x, y, z)` | Change position and send destination chunks. |
| `setGameMode(mode)` | Set the numeric GameMode and notify the client. |
| `kick(reason)` | Disconnect this player. |

Use `api.server.broadcastMessage(text, color?)` for chat to everyone. For block edits use `api.server.setBlock(position, blockId, metadata = 0)`; 1.8.9 still uses numeric ids and metadata.
