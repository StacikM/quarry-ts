# Writing plugins for Minecraft 1.8.9

Place a CommonJS `.js` or `.cjs` file in `plugins/` next to the directory where you start the server, then restart. Plugins run in Node's server process with normal JavaScript access.

1. [Getting started](01-getting-started.md): minimal plugin, load order, cleanup and errors
2. [Events](02-events.md): the 1.8 block id/metadata fields and cancellation
3. [Commands and permissions](03-commands.md)
4. [Timers and saved data](04-scheduler-and-data.md)
5. [Players](05-players.md): messages, teleporting and game mode
6. [Whitelist](06-whitelist.md)
7. [Recipes](07-recipes.md): protection, chat formatting and teleport cooldown

The contract is [src/plugins/types.ts](../../src/plugins/types.ts); builtins in `src/plugins/builtin/` are working examples. Each JavaScript fence is executed by `npx tsx scripts/plugin-docs-check.ts`, reading these pages in filename order. The seven examples exercise the real plugin manager, commands, events, timers, persistence and moderation. Run `npm run check` for the full checks.
