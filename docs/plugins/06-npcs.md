# 6. NPCs and the whitelist

[Back to the index](README.md)

## NPCs

An NPC is a fake player that everybody can see: it has a skin, can hold and wear items, can show a name above its head, can turn to look at players, and fires an event when somebody hits or right-clicks it. It is not an entity with a brain: it stands where you put it.

`api.npcs.spawn(definition)` shows it to everyone online (and to everyone who joins later) and returns the NPC, or `null` (with a warning in the console) when the definition is invalid or the id is already taken.

```js
module.exports = {
  name: "guide-greeter",
  version: "1.0.0",
  onEnable(api) {
    const greeter = api.npcs.spawn({
      id: "guide-greeter",
      position: { x: 0.5, y: 73, z: 4.5 },
      yaw: 180,
      name: "§6Greeter",
      lookAtPlayers: true,
      equipment: {
        mainHand: { item: "diamond_sword" },
        head: { item: "leather_helmet", dyedColor: 0xcc2222 },
      },
    });
    if (!greeter) throw new Error("the greeter could not be spawned");
    api.on("npcInteract", ({ player, npc, click }) => {
      if (npc.id !== "guide-greeter") return; // other plugins have NPCs too
      player.sendMessage(click === "left" ? "Ouch!" : `Hello, ${player.username}!`, "gold");
    });
  },
};
```

### The definition

| Field | Meaning |
| --- | --- |
| `id` | Your unique name for it: 1 to 64 letters, digits, `_`, `-` or `.`. |
| `position` | `{x, y, z}`. The feet of the NPC. |
| `yaw`, `pitch` | Degrees. Yaw 0 faces south, 90 west, 180 north, 270 east. Pitch is positive downwards. |
| `name` | Text above its head, `§` colour codes work. Leave it out for no name. |
| `skin` | `{value, signature?}`: the "textures" profile property as Mojang's session server hands it out. Without it the NPC has a default skin. |
| `equipment` | What it holds and wears: `mainHand`, `offHand`, `head`, `chest`, `legs`, `feet`, each `{item, dyedColor?}`. `item` is an item name; `dyedColor` is `0xRRGGBB` for leather armor. An unknown item refuses the whole definition. |
| `lookAtPlayers` | Turn to face players closer than 8 blocks, and turn back when they leave. |
| `glowing` | Show the glowing outline. |
| `scale` | Accepted and saved, but not shown yet. |

### Looking up and changing

`api.npcs.get(id)` and `api.npcs.list()` find live NPCs, including other plugins' NPCs, so remove only your own. An NPC has `id`, `entityId`, `definition` (read only), and:

| Method | Behavior |
| --- | --- |
| `teleport(position, yaw?, pitch?)` | Move it. |
| `setName(text)` | Change the text above its head (an empty text removes it). |
| `setSkin(skinOrUndefined)` | Change the skin. Clients see it vanish and appear again. |
| `setEquipment(equipmentOrUndefined)` | Replace everything it holds and wears. |
| `remove()` | Take it out of the world. |

The manager removes a plugin's NPCs when the plugin is disabled. NPCs are not saved by themselves: save your definitions with `api.saveData` and spawn them again in `onEnable`, or use the built-in plugin below.

### Clicks

`api.on("npcInteract", handler)` receives `{player, npc, click: "left" | "right", sneaking}`: one event per click, main hand only, and not for spectators. Scope your handler to your own NPC ids. There is no cancelling and no cooldown: add your own per player if you need one.

### The built-in `npcs` plugin

It saves NPCs in `plugins-data/npcs.json`, runs their click actions with a cooldown per player and NPC, and gives operators the `/npc` command (`list`, `create`, `remove`, `tp`, `skin`, `name`, `equip`, `action add|remove|list`). The file looks like this:

```json
{
  "version": 1,
  "npcs": [
    {
      "id": "lobby-guide",
      "position": { "x": 0.5, "y": 47, "z": -13.5 },
      "yaw": 0,
      "name": "§aJoin the SMP",
      "skin": { "value": "...", "signature": "..." },
      "equipment": { "mainHand": { "item": "diamond_sword" } },
      "actions": [{ "click": "any", "type": "server", "value": "smp" }],
      "cooldownMs": 3000
    }
  ]
}
```

An action's `click` is `left`, `right` or `any`, and `type` is one of `player_command`, `console_command`, `message`, `title`, `actionbar`, `server` (move the player to another server through the proxy) or `teleport`; `value` may contain `{player}`. `delayTicks` waits before running it. Identical actions are run once per click. If the file is damaged the plugin refuses to start instead of overwriting it.

To bring NPCs over from FancyNpcs on Paper, see **Moving your FancyNpcs NPCs** in the main [README](../../README.md). The migration is a command you run once on your own computer: it can look up skins on Mojang's servers at that moment (`--fetch-skins`), and the server itself never fetches skins.

## The whitelist

`/whitelist` is for operators and the console; see [Commands](03-commands.md). When it is on, only the listed names and operators can join, and a change kicks online players who are no longer allowed. Bans are checked first. The list is kept in `whitelist.json` (separate from plugin data) and turned on at start with `"whitelist": true` in `server.json` or `QUARRY_WHITELIST=true`. A damaged `whitelist.json` locks everyone but operators out instead of letting everyone in.
