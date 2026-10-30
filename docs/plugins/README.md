# Writing plugins

Put a CommonJS `.js` or `.cjs` file in `plugins/`, next to the directory where you start the server, then restart. Plugins run in the server's Node.js process and have normal JavaScript access. The examples in these pages are complete plugin files; choose unique names if you combine them.

The guide is split by topic. Read them in order the first time, or jump to what you need:

| Page | What is in it |
| --- | --- |
| [1. Getting started](01-getting-started.md) | A minimal plugin, load order, cleanup and errors |
| [2. Events](02-events.md) | Every event, when it fires, and what cancelling does |
| [3. Commands and permissions](03-commands.md) | `registerCommand`, operator-only commands, console commands |
| [4. Timers and saved data](04-scheduler-and-data.md) | `runLater`, `runRepeating`, `loadData` / `saveData` |
| [5. Players](05-players.md) | Messages, titles, giving items, teleporting, moving a player to another server |
| [6. NPCs and the whitelist](06-npcs.md) | Fake players with skins, equipment and click events; the `/whitelist` list |
| [7. Recipes](07-recipes.md) | Protect an area, rank-prefixed chat, a teleport command with a cooldown |

The TypeScript contract for all of it is [src/plugins/types.ts](../../src/plugins/types.ts); the built-in plugins in `src/plugins/builtin/` are working examples.

## Checking the examples

Every JavaScript block in these pages is extracted and run by `npx tsx scripts/plugin-docs-check.ts`. It enables each plugin through the real manager in a temporary directory, exercises its behavior, and checks persistence, operator permissions, cooldown expiry, moderation order, NPC clicks and timer cleanup. The existing suites are `npm run check`; run the guide checker after editing examples too. Put new runnable examples in a `js` code block, and keep the blocks of one page in the order the checker expects (see the checker for the numbers).
