# Quarry.ts

A Minecraft **1.21.11** server written in TypeScript, kept small enough to read. (This is the `mc-1.21.11` branch; the `main` branch is the same server for 1.8.9.)

It has generated terrain (biomes, caves, ores, trees, plants), players who can see each other, chat, commands, block building and breaking, a plugin system, and a world that is saved to disk. It runs in offline mode (see "Not implemented"), or behind a Velocity proxy, and uses little memory: it is meant for things like lobby servers.

## About this project: 100% AI-generated, and tested

Created and directed by **Stacik**.

**Every line of code, test and document in this repository was written by AI**, not by a human programmer: [Claude](https://www.anthropic.com/claude) (Anthropic) and Codex (OpenAI) built it together, with a human directing the work, playing the server and reporting bugs. The two AIs also reviewed each other's code.

"Tested" here means specific things, so you can judge for yourself:

- **Automated tests.** `npm run check` type-checks everything and runs the test suites: terrain generation (the same seed gives the same world in any order), world saving including damaged and unreadable files, the plugin system, lighting, doors, moderation and the console, and the network protocol.
- **Checked against the real game, not just against our own code.** Block states, light and glow values, and collision shapes come from the community data set minecraft-data (every one of the 29,671 block states is checked against an independent decoder), and the standard tag lists were read from the game itself. Network packets are decoded with an independent library (PrismarineJS) that we did not write.
- **A real client joins over a real connection in the tests.** `minecraft-protocol`, a separate implementation of the 1.21.11 protocol, logs in, receives the chunks (compared block for block with the server's world), chats, runs commands, and places and breaks blocks.
- **Played in a real Minecraft client.** On the 1.8.9 branch that found real bugs (black blocks after breaking a cactus, doors that did nothing), which were fixed and now have tests. On this branch, the real 1.21.11 client found that it needs the standard tag lists before it will join; that is fixed too.

What it is **not**: it has not had a human code review or a security audit, it has not been run with many players at once, and it runs in offline mode, so players are not authenticated. Treat it as a learning project and do not expose it to the internet. See "Not implemented" below.

*This is an unofficial project. It is not affiliated with, endorsed by or connected to Mojang Studios or Microsoft. "Minecraft" is a trademark of Mojang Studios.*

## Installing a server

The easy way is the interactive installer. It checks that Node.js 24 or newer is installed, installs and builds the server, and then asks a few questions (port, world type, seed, lobby protection, Velocity, operators):

- **Windows:** double-click `install.bat`
- **Linux and macOS:** `bash install.sh`

The answers go into `server.json` (plus `velocity.json` and `ops.json` if you used them). Run `node scripts/setup.cjs` to answer the questions again. You can also edit the file by hand:

```json
{ "port": 25565, "motd": "My lobby", "maxPlayers": 50, "viewDistance": 6,
  "generator": "void", "seed": 1234, "mapFolder": "maps/lobby", "protectWorld": true }
```

Every key is optional. `generator` is `natural`, `flat` or `void`. **Without a `seed`, every server gets its own random one**: it is made the first time the server starts and kept in `world/seed.txt`, so the world is the same after a restart. (A word works as a seed too.) A world saved by an older version under seed 1337 is found again with `"seed": 1337`.

**Hosting panels:** the same settings can be given as environment variables, which win over the file: `QUARRY_PORT` (or the panel's `SERVER_PORT`), `QUARRY_GENERATOR`, `QUARRY_SEED`, `QUARRY_MAP`, `QUARRY_PROTECT_WORLD`, `QUARRY_MOTD`, `QUARRY_MAX_PLAYERS`, `QUARRY_VIEW_DISTANCE`, `QUARRY_VELOCITY_SECRET` and `QUARRY_OPS` (names separated by commas).

**Pterodactyl:** import [pterodactyl/egg-quarry-ts.json](pterodactyl/egg-quarry-ts.json) (Admin area, Nests, Import Egg) and create a server from it. The install script downloads this repository's `mc-1.21.11` branch from GitHub, builds it, and the panel shows every setting above as a variable. Reinstalling the server updates the program and keeps the world and settings. After changing `pterodactyl/install.sh` or the variables in `pterodactyl/build-egg.cjs`, run `node pterodactyl/build-egg.cjs` to rebuild the egg file.

## Running it

```sh
npm install
npm run play       # build and start the server: use this to actually play
```

`npm run dev` also starts it, straight from the TypeScript source, which is handy while editing code, but it runs about **5 times slower** (in a measurement, generating a new area took 1.8 s instead of 0.35 s). `npm run build` then `npm start` is the same as `npm run play` in two steps.

**Why teleporting and flying don't freeze the server:** chunks are not all sent at once. Only the 3x3 around you arrive immediately, so you never fall through the world, and the rest stream in a few per tick, nearest first. The budget is `chunkBudgetMs` in [src/config.ts](src/config.ts). Autosaves are spread over ticks the same way. `/perf` shows how many chunks are still waiting.

In Minecraft 1.21.11: Multiplayer, then Add Server, then `localhost`. The server only accepts 1.21.11 clients.

**Behind a Velocity proxy:** create a file `velocity.json` next to where you start the server, with `{ "enabled": true, "secret": "the text in Velocity's forwarding.secret" }` (or set the environment variable `QUARRY_VELOCITY_SECRET`), and set `player-info-forwarding-mode = "modern"` in Velocity's `velocity.toml`. The server then takes each player's name, UUID and real IP address from the proxy, checks the proxy's signature, and **refuses direct connections**. Keep the port closed to the internet, so that only the proxy can reach it. The file is ignored by git because it holds a password.

## Using it as a lobby

Everything here is in [src/config.ts](src/config.ts) (the map can also be set with the environment variable `QUARRY_MAP`).

- **An existing world as the map.** Set `mapFolder` to the folder of a Minecraft 1.18-or-newer world (the one that contains `region/`, for example your Paper lobby) and the server shows it. It reads the `region` files and `level.dat` (for the spawn point) and never changes them; what players change is saved separately, in this server's own `world/` folder. Limits: only y 0 to 255 is loaded, and chests, signs, other block entities and entities such as armor stands are not (yet). Blocks this version does not know become air, and the server prints a warning.
- **An empty world.** `generator: "void"` gives a small stone platform and nothing else, to build a lobby on from scratch.
- **Protection.** `lobby: { protectWorld: true }` lets only operators build or break, and puts everyone else in adventure mode.
- **Sending players to other servers.** Behind Velocity, a plugin can call `player.connectToServer("survival")` (the server name from `velocity.toml`).

**Before you play:** type `op YourMinecraftName` in the server console (it saves the name to an `ops.json` file in the folder you start the server from, which you can also edit by hand, like `["YourName"]`). Operators can use `/gamemode` and `/tp` and can build inside the spawn protection area. The file is ignored by git, so your name is never committed. The seed, port, MOTD, view distance and world type are in `server.json` (see "Installing a server" above); everything else you may want to change is in [src/config.ts](src/config.ts).

## Commands

Type these in game with a `/` in front, or in the server console (the terminal where the server runs) without it. In the console, `help` lists them. Anything that is not a command is NOT sent to players, so a typo can't become public chat.

| Command | Who | What it does |
| --- | --- | --- |
| `/tps` | everyone | Ticks per second (20 is perfect), time per tick, and how late the server reacts |
| `/mem` | operators | Memory: whole process, JavaScript heap and its limit, buffers, and the chunks in memory |
| `/perf` | operators | Everything: uptime, players, CPU, TPS, memory, and how long chunk generation and lighting take |
| `/kick <player> [reason]` | operators | Disconnect a player (they can rejoin) |
| `/ban <player> [reason]` | operators | Ban a name. Works on players who are offline too |
| `/banip <player or IP> [reason]` | operators | Ban an address, which kicks everyone using it |
| `/unban <name>`, `/pardon <name>` | operators | Lift a name ban |
| `/unbanip <IP>` | operators | Lift an address ban |
| `/banlist` | operators | Show who is banned, by whom and when |
| `/op <name>`, `/deop <name>`, `/ops` | operators | Give, take away and list operator status |
| `/say <message>`, `/save`, `/list`, `/plugins`, `/seed` | operators / everyone | Broadcast, save the world now, who is online, plugins, world seed |
| `/gamemode`, `/tp`, `/spawn` | in game only | Game mode (`c`, `s`, `a`, `sp` or 0-3), teleport to a player, go to spawn |

From the bundled plugins: `/sethome`, `/home`, `/warp`, `/warps`, `/setwarp`, `/rules`. The console also has `stop` (save and shut down) and `stop force`.

**Bans:** they are saved in `bans.json` next to `ops.json` (both ignored by git). Names are very easy to change on this server because it does not check accounts, so a name ban stops casual griefing but a determined person just rejoins under another name. `/banip` is the stronger tool. Be careful with it on a home network: banning `127.0.0.1` blocks everyone playing on the same computer, and many people share one address behind a router. Operators cannot kick or ban other operators from in game; the console can.

**Reading `/tps` and `/mem`:** the server runs 20 ticks a second. If it falls below about 15, something is keeping the program busy (usually generating a lot of new chunks at once, for example when someone flies fast). "Delays" shows the worst freezes, which TPS can hide. In `/mem`, "Whole process" is what Task Manager shows; the JavaScript heap has a limit (usually about 4 GB, raised with `node --max-old-space-size=8192`), and chunk data lives in "Buffers".

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
| [src/network/framing.ts](src/network/framing.ts) | Packet compression (large packets such as chunks are zipped). |
| [src/network/Connection.ts](src/network/Connection.ts) | One client's socket. Cuts the byte stream into packets and routes each one by connection state (handshake, status, login, configuration, play). |

**Protocol: what the packets mean**

| File | What it does |
| --- | --- |
| [src/protocol/packetIds.ts](src/protocol/packetIds.ts) | Every packet ID used, grouped by state and direction. |
| [src/protocol/clientbound.ts](src/protocol/clientbound.ts) | One function per packet the server sends. |
| [src/protocol/chunkEncoding.ts](src/protocol/chunkEncoding.ts) | Turns a chunk into the packet's bytes (block palettes, biomes, light). |
| [src/protocol/registryKeys.ts](src/protocol/registryKeys.ts), [vanillaTags.ts](src/protocol/vanillaTags.ts) | Generated lists the client needs while joining (biome names, damage types, standard tags). |
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

1. **Handshake**: the client sends its protocol version (774 for 1.21.11) and whether it wants Status or Login.
2. **Status**: the server answers the server-list ping with the MOTD and player count.
3. **Login**: the client sends its name; the server turns on compression and replies with Login Success (behind Velocity it first asks the proxy who the player really is).
4. **Configuration**: the server sends the lists the game needs (biomes, damage types, tags...) by name, because the client already has the standard data.
5. **Play**: the server sends Login, the player's position and the chunks around them. After that both sides exchange packets until someone disconnects.

## How the world is saved

The terrain generator can rebuild untouched terrain from the seed, so only the blocks that players or plugins changed are written to disk, one small file per chunk, in `world/<generator>-<seed>/`. When a chunk is needed again it is generated and the saved changes are applied on top. Files are written to a temporary file, flushed to disk, then renamed into place, so a crash cannot leave a half-written save.

Two things to know:

- **Changing the terrain generator changes unedited terrain in existing worlds.** Your own edits stay, but a newly added tree or cave can appear next to (or inside) an area you cleared, and a tree you cut down may leave a few floating leaves if the new generator places it differently. Changing the `seed` starts a new, separate world folder.
- **A save file with damaged contents** is set aside as `*.corrupt` and that chunk is regenerated without your edits. A file that merely *cannot be read right now* (disk error) is left alone and the chunk is not loaded, so a temporary problem never overwrites your build.
- Plugins should not hold on to a `Chunk` object, because far-away chunks are unloaded. Keep coordinates and call `world.setBlock()` when you need to change something.

## Not implemented (good things to try adding)

- **Online mode.** Right now the server trusts whatever username a client sends, so anyone can join as anyone, and nobody has a skin. Do not open this server to the internet as it is.
- Inventories, health and hunger, item drops
- Mobs
- Block tags beyond the standard lists (nothing here adds custom ones), block entities such as chests and signs, and a world taller than 256 blocks (building stops at y=255)

## License

[MIT](LICENSE), Copyright (c) 2026 Stacik. You may use, change and share it freely, including commercially, as long as the license text stays with it. It comes with no warranty.
