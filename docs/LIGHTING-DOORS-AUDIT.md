# Vanilla 1.8.9 lighting and door audit

## Reference selection

The requested comparison uses [`minecraft-data@3.109.0` blocks.json](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.8/blocks.json) and [items.json](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.8/items.json). Its legacy light entries are not reliable enough to become the implementation: examples include opaque flowers and glowing unlit furnaces, torches and lamps.

To resolve disagreements, `scripts/extract-vanilla-light.cjs` reads the locally installed **unmodified Mojang 1.8.9 client jar**, verifies SHA-1 `3870888a6c3d349d3771a3e9d16c9bf5e076b908`, and compiles our small reflection probe. The probe initializes only the block registry and reads its opacity/emission fields; it does not start the game, connect to a server, or alter the installed game. The binary is identified by its [Mojang object URL](https://launcher.mojang.com/v1/objects/3870888a6c3d349d3771a3e9d16c9bf5e076b908/client.jar).

Results for every ID 0–197 are recorded in `docs/reference/vanilla-1.8.9-light.json`. The complete old-table/data/vanilla comparison is `docs/reference/light-data-comparison.json`, with baseline commit `f86987f`. Only our probe and numerical reference data are included in the project; the game jar is not redistributed.

The version-specific reflection names are confined to the probe script. It checks six distinguishing air/stone/water/leaves/torch/lava cases before extracting all entries. This cross-check avoids treating a reflected field name as self-authenticating evidence.

## Complete lighting table

`src/world/lightData.ts` now contains all 198 verified entries. Generate it with `node scripts/generate-light-data.cjs`; check it with `npx tsx scripts/light-data-check.ts`. Refreshing the independent fixture additionally requires a local 1.8.9 installation and a JDK. Normal server startup and checks do not need Java or the game jar.

Minecraft-data expresses fully opaque blocks with filterLight 15; this engine uses actual vanilla opacity 255. That sentinel difference is normalized before comparison. The remaining differences are genuine data disagreements, rather than missing normalization. There are 46 differing old-table/data rows, 15 actual old-table mistakes against vanilla, and 35 minecraft-data/vanilla disagreements. Overlapping sets explain why those counts do not add directly.

The corrected table retains verified water/ice opacity 3, leaves/cobweb opacity 1, and opaque slabs/stairs/farmland. It also removes the accidental end-rod entry at ID 198, which belongs to a later version. Do not infer light opacity from visual shape or the data's `transparent` flag. The [vanilla Block constructor/registration](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/Block.java) and [slab constructor](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/BlockSlab.java) explain these otherwise surprising values.

The tables below are generated from the checked reference comparison. Each pair is **opacity / emission**. The minecraft-data column shows its raw **filterLight / emitLight**, before converting opaque 15 to 255.

### All original-table / minecraft-data differences

| ID | Name | Original | minecraft-data | Actual vanilla |
| --- | --- | --- | --- | --- |
| 8 | flowing_water | 3/0 | 2/0 | 3/0 |
| 9 | water | 3/0 | 2/0 | 3/0 |
| 18 | leaves | 1/0 | 0/0 | 1/0 |
| 29 | sticky_piston | 255/0 | 0/0 | 0/0 |
| 30 | web | 1/0 | 0/0 | 1/0 |
| 33 | piston | 255/0 | 0/0 | 0/0 |
| 34 | piston_head | 0/0 | 15/0 | 0/0 |
| 37 | yellow_flower | 0/0 | 15/0 | 0/0 |
| 38 | red_flower | 0/0 | 15/0 | 0/0 |
| 39 | brown_mushroom | 0/1 | 15/1 | 0/1 |
| 40 | red_mushroom | 0/0 | 15/1 | 0/0 |
| 43 | double_stone_slab | 255/0 | 0/0 | 255/0 |
| 44 | stone_slab | 255/0 | 0/0 | 255/0 |
| 46 | tnt | 255/0 | 0/0 | 255/0 |
| 52 | mob_spawner | 255/0 | 0/0 | 0/0 |
| 61 | furnace | 255/0 | 0/13 | 255/0 |
| 62 | lit_furnace | 255/13 | 0/13 | 255/13 |
| 73 | redstone_ore | 255/0 | 0/9 | 255/0 |
| 74 | lit_redstone_ore | 255/9 | 0/9 | 255/9 |
| 75 | unlit_redstone_torch | 0/0 | 0/7 | 0/0 |
| 79 | ice | 3/0 | 2/0 | 3/0 |
| 89 | glowstone | 255/15 | 0/15 | 255/15 |
| 90 | portal | 0/11 | 15/0 | 0/11 |
| 94 | powered_repeater | 0/9 | 0/0 | 0/0 |
| 104 | pumpkin_stem | 255/0 | 0/0 | 0/0 |
| 105 | melon_stem | 255/0 | 0/0 | 0/0 |
| 116 | enchanting_table | 255/0 | 0/0 | 0/0 |
| 119 | end_portal | 0/15 | 15/0 | 0/15 |
| 120 | end_portal_frame | 255/0 | 0/1 | 0/1 |
| 123 | redstone_lamp | 255/0 | 0/15 | 255/0 |
| 124 | lit_redstone_lamp | 255/15 | 0/15 | 255/15 |
| 125 | double_wooden_slab | 255/0 | 0/0 | 255/0 |
| 126 | wooden_slab | 255/0 | 0/0 | 255/0 |
| 127 | cocoa | 255/0 | 0/0 | 0/0 |
| 130 | ender_chest | 255/7 | 0/7 | 0/7 |
| 138 | beacon | 255/15 | 0/15 | 0/15 |
| 141 | carrots | 0/0 | 15/0 | 0/0 |
| 142 | potatoes | 0/0 | 15/0 | 0/0 |
| 152 | redstone_block | 255/0 | 0/0 | 255/0 |
| 157 | activator_rail | 255/0 | 0/0 | 0/0 |
| 161 | leaves2 | 1/0 | 0/0 | 1/0 |
| 165 | slime | 255/0 | 0/0 | 0/0 |
| 169 | sea_lantern | 255/15 | 0/15 | 255/15 |
| 175 | double_plant | 0/0 | 15/0 | 0/0 |
| 181 | double_stone_slab2 | 255/0 | 0/0 | 255/0 |
| 182 | stone_slab2 | 255/0 | 0/0 | 255/0 |

### Actual original-table errors corrected

| ID | Name | Original | minecraft-data | Actual vanilla |
| --- | --- | --- | --- | --- |
| 29 | sticky_piston | 255/0 | 0/0 | 0/0 |
| 33 | piston | 255/0 | 0/0 | 0/0 |
| 36 | piston_extension | 255/0 | 15/0 | 0/0 |
| 52 | mob_spawner | 255/0 | 0/0 | 0/0 |
| 94 | powered_repeater | 0/9 | 0/0 | 0/0 |
| 104 | pumpkin_stem | 255/0 | 0/0 | 0/0 |
| 105 | melon_stem | 255/0 | 0/0 | 0/0 |
| 116 | enchanting_table | 255/0 | 0/0 | 0/0 |
| 120 | end_portal_frame | 255/0 | 0/1 | 0/1 |
| 127 | cocoa | 255/0 | 0/0 | 0/0 |
| 130 | ender_chest | 255/7 | 0/7 | 0/7 |
| 138 | beacon | 255/15 | 0/15 | 0/15 |
| 150 | powered_comparator | 0/0 | 0/0 | 0/9 |
| 157 | activator_rail | 255/0 | 0/0 | 0/0 |
| 165 | slime | 255/0 | 0/0 | 0/0 |

## Doors: independently verified

All seven item/block mappings match the installed items/blocks data: oak 324→64, iron 330→71, spruce 427→193, birch 428→194, jungle 429→195, acacia 430→196 and dark oak 431→197.

Metadata and rotation were checked against decompiled [vanilla ItemDoor](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/item/ItemDoor.java), [BlockDoor](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/BlockDoor.java) and [EnumFacing](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/util/EnumFacing.java), not guessed from item names. Lower bits 0–1 store the clockwise-rotated horizontal index; bit 2 stores open. Upper bit 3 marks the upper half, bit 0 means right hinge, and bit 1 represents powered state (redstone is currently outside scope).

For yaw 0/90/180/270, lower closed metadata is 1/2/3/0. This matches the implementation. The hinge rule using a door on the left, no door on the right, or more normal cubes on the right also matches vanilla. No facing-bit reversal was found.

## Door findings sent to Claude

1. **P2 — opacity is not collision/support geometry**, `src/game/doors.ts:82` and `:127`. The same `isSolid()` helper is used for hinge-wall counting and floor support, but vanilla uses distinct rules. A right-side stair block 53 is opaque to light yet is not a normal cube: our compiled fixture chose upper metadata 9 (right hinge), whereas vanilla chooses 8 (left hinge). A bottom stone slab is incorrectly accepted as floor support; a hopper is incorrectly rejected.
2. **P2 — top valid door position is refused**, `src/game/doors.ts:71`. The implementation rejects lower halves above 253. Vanilla [BlockDoor.canPlaceBlockAt](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/BlockDoor.java#L263) rejects lower Y≥255, so lower Y254 with upper Y255 is legal when supported.

The support distinction comes directly from [World.doesBlockHaveSolidTopSurface](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/world/World.java#L2230): normal full material cubes, upper stairs/slabs, hoppers and the specified snow-layer case are separate predicates. Hinge-wall counting uses `Block.isNormalCube()`, which also excludes power-providing blocks. Reusing a lighting lookup cannot express those metadata-dependent rules.

Both categories were reproduced with pure in-memory worlds against the compiled `planDoor()`. Claude corrected stair hinge classification, bottom/top slab and hopper support, and lower Y254; the independent fixtures now pass those cases.

One part of the same predicate issue remains after that first correction: right-side TNT 46, glowstone 89, redstone block 152 and sea lantern 169 still select upper metadata 9 instead of vanilla 8. [Material.glass and Material.tnt are translucent](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/material/Material.java), and [redstone blocks provide power](https://github.com/Marcelektro/MavenMCP-1.8.9/blob/master/src/main/java/net/minecraft/block/BlockCompressedPowered.java), so `Block.isNormalCube()` excludes them regardless of their opacity. This was sent back to Claude with compiled reproductions. The support predicate must remain separate: a full redstone block can support a door even though it must not count as a normal-cube hinge wall.

Door implementation files were left to Claude. A human visual retest of cactus lighting and door interaction is still needed after the fixes; this table audit does not claim to verify screen appearance, full redstone behavior or cross-chunk light propagation.
