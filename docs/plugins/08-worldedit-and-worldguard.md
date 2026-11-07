# 8. Building tools: WorldEdit and WorldGuard

[Back to the index](README.md)

Two built-in plugins with the command names of the well-known Java plugins. They are small rewrites, not the real thing, and they are for operators only. Their source is in `src/plugins/builtin/worldedit/` and `src/plugins/builtin/worldguard/`.

## WorldEdit

Select a box, then change it. Get the wand with `//wand` (a wooden axe): **left click** a block for the first corner, **right click** for the second. The axe does not break or place anything while you are an operator. `//pos1` and `//pos2` use the block you stand in, `//hpos1` and `//hpos2` the block you look at.

| Command | What it does |
| --- | --- |
| `//wand`, `//pos1`, `//pos2`, `//hpos1`, `//hpos2`, `//desel`, `//size` | Selecting. `//size` shows the size and the corners |
| `//expand <n> [dir]`, `//expand vert`, `//contract <n> [dir]`, `//shift <n> [dir]` | Resize or slide the selection. `dir` is `n`, `s`, `e`, `w`, `u`, `d` or `me` (the way you look, the default) |
| `//set <pattern>` | Fill the selection |
| `//replace [<from>] <to>` | Replace the blocks matching `from` (every solid block when it is left out) |
| `//walls <pattern>` | The four sides, no floor or roof |
| `//sphere <pattern> <radius>`, `//hsphere ...` | A ball centred on you (`hsphere`, or the flag `-h`: hollow) |
| `//cyl <pattern> <radius> [height]`, `//hcyl ...` | A column going up from your feet (`hcyl` or `-h`: only the ring) |
| `//count <blocks>` | Count the blocks that match in the selection |
| `//copy`, `//cut`, `//paste [-a]`, `//clearclipboard` | Copy, move to the clipboard, paste where you stand (the copy remembers where you stood; `-a` leaves air out) |
| `//move <n> [dir] [leave]`, `//stack <times> [dir]` | Move the contents (leaving air or `leave`), or repeat them next to themselves |
| `//undo [times]`, `//redo [times]` | Take edits back, or put them back |

A **block** is a name: `stone`, `minecraft:stone`, `oak_stairs[facing=north,half=top]`. A **pattern** is one block, or a list picked at random: `50%stone,30%dirt,gravel` (`hand` is the block you hold). A **mask** (the `from` of `//replace`, and `//count`) is a list: `stone,dirt`; a block without `[...]` matches all of its states.

Limits: an edit may touch 250,000 blocks, a sphere or cylinder may have a radius of up to 100, and the heights are 0 to 255. A refused edit changes nothing. Each player keeps about 500,000 blocks of undo history, plus one clipboard; both are forgotten when the player leaves. Edits do not trigger physics (water does not flow, plants do not break), and nothing is dropped.

Not included: schematics, rotation and flipping, brushes, biomes, regeneration, and `//up`-style movement commands.

## WorldGuard

Name a box of the world with `/region` (or `/rg`), then say who may build there.

| Command | What it does |
| --- | --- |
| `/rg define <id> [owners...]` | Make a region from your WorldEdit selection. `redefine <id>` gives it a new box |
| `/rg remove <id>`, `/rg list`, `/rg info [id]` | Remove, list, or look at a region (without an id: the one you stand in) |
| `/rg addowner`, `removeowner`, `addmember`, `removemember <id> <names...>` | Who belongs to it |
| `/rg flag <id> <flag> [value...]` | Set a flag; without a value it is removed |
| `/rg setpriority <id> <number>` | Overlapping regions: only the ones with the highest priority count |
| `/rg bypass [on\|off]` | Operators ignore regions by default; turn it off to test them |

Flags:

| Flag | Value | Effect |
| --- | --- | --- |
| `build` | `allow` / `deny` | Breaking and placing. Not set: only owners and members. `allow`: everybody. `deny`: nobody (operators with bypass still can) |
| `block-break`, `block-place` | `allow` / `deny` | Like `build`, for one action; they win over `build` |
| `tnt` | `allow` / `deny` | Whether explosions destroy blocks there. Not set: a region is protected (and the global region is not). Lighting TNT counts as breaking the block, so `build` applies to that too |
| `entry` | `deny` | Only owners and members may walk in (others are put back where they were) |
| `greeting`, `farewell` | text | Sent to a player who walks in or out. `&a` colour codes work |
| `deny-message` | text | What a refused builder is told instead of "Hey! Sorry, but you can't build here." |

The region named `__global__` covers the whole world: `/rg flag __global__ build deny` makes the world read-only for everybody but operators. Regions are saved in `plugins-data/worldguard.json`.

It looks at breaking blocks, placing blocks and walking. It does not protect doors or other uses of a block, and there is no fire or mob spawning on this server, so those flags do not exist. Fighting between players exists in the core (melee and bows) but has no region flag: plugins decide where damage is allowed by cancelling `playerDamage`. WorldEdit edits are not checked against regions (only operators can edit).

## For plugin authors

Both plugins are built on two additions you can use too:

- The event `playerInteract` (see [Events](02-events.md)) tells you about clicks on blocks and the item in hand, and can cancel them.
- `api.server.setBlocks(changes)` places many blocks at once, `[{ x, y, z, state }, ...]`, and sends each 16x16x16 section as one packet.
