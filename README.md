# mcserver-ts

A Minecraft **1.8.9** server written in TypeScript, kept small enough to read.

It has generated terrain (biomes, caves, ores, trees, plants), players who can see each other, chat, commands, block building and breaking, a plugin system, and a world that is saved to disk. It runs in offline mode (see "Not implemented").

## Running it

```sh
npm install
npm run dev        # run straight from the TypeScript source
# or
npm run build      # compile to dist/
npm start          # run the compiled code
```

In Minecraft 1.8.9: Multiplayer, then Add Server, then `localhost`.

**Before you play:** open [src/config.ts](src/config.ts) and put your Minecraft username in `ops`. Operators can use `/gamemode` and `/tp` and can build inside the spawn protection area. Everything else you may want to change is in that file too: the seed, the port, the MOTD, view distance, and whether the world is `"natural"` or `"flat"`.

Server console commands: `save` writes the world to disk now, `stop` saves and shuts down, and anything else you type is sent to everyone as chat. If the world cannot be saved (disk full, folder not writable), `stop` keeps the server running and tells you; fix the problem and run `stop` again. `stop force` (or pressing Ctrl+C a second time) quits anyway and loses the unsaved changes.

In-game commands: `/help` lists everything. Built in: `/list`, `/gamemode`, `/spawn`, `/tp`, `/plugins`, `/seed`. From the bundled plugins: `/sethome`, `/home`, `/warp`, `/warps`, `/setwarp`, `/rules`.

## Checking that nothing broke

```sh
npm run check
```

This type-checks everything and runs the tests for the plugin runtime, world saving (including damaged save files), terrain generation (same seed gives the same world, whatever order chunks are made in), and the bundled plugins. It uses temporary folders, so it never touches your real `world/` or `plugins-data/`.

To look at the terrain without starting Minecraft: `npx tsx scripts/terrain-preview.ts 1337 192 128` prints a top-down ASCII map and a vertical slice.

## Where things are

Read the files roughly in this order.

**Starting up and settings**

| File | What it does |
| --- | --- |
| [src/index.ts](src/index.ts) | Entry point. Starts the server and reads console input. |
| [src/config.ts](src/config.ts) | Every setting in one place. |

**Network: raw bytes to packets**

| File | What it does |
| --- | --- |
| [src/network/VarInt.ts](src/network/VarInt.ts) | The variable-length integer format used all over the protocol. |
| [src/network/PacketReader.ts](src/network/PacketReader.ts) | Reads fields (ints, strings, positions...) out of an incoming packet. |
| [src/network/PacketWriter.ts](src/network/PacketWriter.ts) | Builds outgoing packets field by field. |
| [src/network/Connection.ts](src/network/Connection.ts) | One client's socket. Cuts the byte stream into packets and routes each one by connection state. |

**Protocol: what the packets mean**

| File | What it does |
| --- | --- |
| [src/protocol/packetIds.ts](src/protocol/packetIds.ts) | Every packet ID used, grouped by state and direction. |
| [src/protocol/clientbound.ts](src/protocol/clientbound.ts) | One function per packet the server sends. |
| [src/protocol/handlers/](src/protocol/handlers/) | Handlers for incoming packets, one file per state. `play.ts` is where chat, movement and block changes arrive, and where plugin events are fired. |

**Game: players and the server**

| File | What it does |
| --- | --- |
| [src/game/Server.ts](src/game/Server.ts) | Owns the world, the players and the plugins. Handles joining, leaving, keep-alives and autosave. |
| [src/game/Player.ts](src/game/Player.ts) | Per-player state: position, game mode, which chunks the client has. |
| [src/game/commands.ts](src/game/commands.ts) | The built-in chat commands. |
| [src/game/createWorld.ts](src/game/createWorld.ts) | Picks the terrain generator and the save folder. |

**World: blocks and terrain**

| File | What it does |
| --- | --- |
| [src/world/Chunk.ts](src/world/Chunk.ts) | Block storage for a 16x256x16 column, sky lighting, and the encoding sent to the client. |
| [src/world/World.ts](src/world/World.ts) | All the chunks, get/set block by world coordinates, saving and unloading. |
| [src/world/WorldStorage.ts](src/world/WorldStorage.ts) | The save file format. Only blocks that players changed are saved. |
| [src/world/TerrainGenerator.ts](src/world/TerrainGenerator.ts) | The interface every terrain generator implements. |
| [src/world/terrain/](src/world/terrain/) | The natural generator: noise, biomes, caves, ores, trees, plants. |
| [src/world/FlatGenerator.ts](src/world/FlatGenerator.ts) | The simple flat world. |

**Plugins**

| File | What it does |
| --- | --- |
| [src/plugins/types.ts](src/plugins/types.ts) | The plugin API: events, commands, the `api` object. Start here to write a plugin. |
| [src/plugins/PluginManager.ts](src/plugins/PluginManager.ts) | Loads plugins and cleans up after them. |
| [src/plugins/EventBus.ts](src/plugins/EventBus.ts), [CommandRegistry.ts](src/plugins/CommandRegistry.ts), [Scheduler.ts](src/plugins/Scheduler.ts) | The shared pieces every plugin registers into. |
| [src/plugins/builtin/](src/plugins/builtin/) | Plugins that ship with the server (homes, warps, spawn protection, welcome, chat format). |
| [plugins/example.js](plugins/example.js) | A small plugin in plain JavaScript. |

## Writing a plugin

Drop a `.js` file in the `plugins/` folder and restart. It looks like this:

```js
module.exports = {
  name: "hello",
  version: "1.0.0",
  onEnable(api) {
    api.on("playerJoin", ({ player }) => player.sendMessage("Welcome!"));
    api.registerCommand({
      name: "hi",
      description: "Say hi",
      run: (player) => player.sendMessage("hi"),
    });
  },
};
```

Plugins can listen to `playerJoin`, `playerQuit`, `playerChat`, `playerCommand`, `playerMove`, `blockBreak` and `blockPlace`. Some of those can be cancelled (set `event.cancelled = true`), and chat can be reshaped with `event.format`. Plugins can also add commands, run code later or repeatedly, and save data. Everything a plugin registers is removed when it is disabled, and a plugin that throws an error cannot take the server down. The full API with comments is in [src/plugins/types.ts](src/plugins/types.ts).

## How a connection works

1. **Handshake**: the client sends its protocol version (47 for 1.8.x) and whether it wants Status or Login.
2. **Status**: the server answers the server-list ping with the MOTD and player count.
3. **Login**: the client sends its name and the server replies with Login Success.
4. **Play**: the server sends Join Game, the chunks around the player, and the player's position. After that both sides exchange packets until someone disconnects.

## How the world is saved

The terrain generator can rebuild untouched terrain from the seed, so only the blocks that players or plugins changed are written to disk, one small file per chunk, in `world/<generator>-<seed>/`. When a chunk is needed again it is generated and the saved changes are applied on top. Files are written to a temporary file, flushed to disk, then renamed into place, so a crash cannot leave a half-written save.

Two things to know:

- **Changing the terrain generator changes unedited terrain in existing worlds.** Your own edits stay, but a newly added tree or cave can appear next to (or inside) an area you cleared, and a tree you cut down may leave a few floating leaves if the new generator places it differently. Changing the `seed` starts a new, separate world folder.
- **A save file with damaged contents** is set aside as `*.corrupt` and that chunk is regenerated without your edits. A file that merely *cannot be read right now* (disk error) is left alone and the chunk is not loaded, so a temporary problem never overwrites your build.
- Plugins should not hold on to a `Chunk` object, because far-away chunks are unloaded. Keep coordinates and call `world.setBlock()` when you need to change something.

## Not implemented (good things to try adding)

- **Online mode.** Right now the server trusts whatever username a client sends, so anyone can join as anyone, and nobody has a skin. Do not open this server to the internet as it is.
- Packet compression
- Inventories, health and hunger, item drops
- Mobs
- Light that spreads sideways, and light from torches or lava (sunlight only goes straight down)
