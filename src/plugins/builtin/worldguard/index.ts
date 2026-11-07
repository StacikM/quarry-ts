import type { Plugin } from "../../types";
import type { Player } from "../../../game/Player";
import { selectionOf } from "../worldedit/session";
import {
  ALLOW_DENY_FLAGS, checkBuild, checkEntry, colorize, contains, explosionMayDestroy, GLOBAL_REGION, pvpAllowed, MAX_TEXT_LENGTH, readRegions, regionIdsAt,
  TEXT_FLAGS, validPlayerName, validRegionId, type BuildAction, type Pos, type Region,
} from "./regions";

/**
 * A small WorldGuard: name boxes of the world and say who may build in them and what happens there.
 * The command is /region (or /rg); only operators can use it. Boxes are chosen with the WorldEdit
 * selection (the wooden axe, //pos1 and //pos2). The rules are described in regions.ts.
 *
 * It looks at breaking and placing blocks (lighting TNT counts as breaking it), explosions, damage between players, and walking in and out. It does not protect doors and the like,
 * and there is no fire on this server, so that flag does not exist.
 */

const HELP = [
  "/rg define <id> [owners...]   make a region from your selection",
  "/rg redefine <id>   give it your selection instead",
  "/rg remove <id>   /rg list   /rg info [id]",
  "/rg addowner|removeowner|addmember|removemember <id> <names...>",
  "/rg flag <id> <flag> [value...]   (no value removes the flag)",
  `   flags: ${[...ALLOW_DENY_FLAGS, ...TEXT_FLAGS].join(", ")}`,
  "/rg setpriority <id> <number>   /rg bypass [on|off]",
];

/** A mistake of the player: the message is shown to them as it is. */
class Failure extends Error {}

const blockOf = (player: Player): Pos => ({ x: Math.floor(player.x), y: Math.floor(player.y), z: Math.floor(player.z) });

export const worldGuardPlugin: Plugin = {
  name: "worldguard",
  version: "1.0.0",
  onEnable(api) {
    let regions = readRegions(api.loadData<unknown>({}));

    const save = (): void => api.saveData({ regions });
    const find = (id: string | undefined): Region => {
      // The global region always exists in a way: it is made when something is first set on it.
      if (id?.toLowerCase() === GLOBAL_REGION && !regions.some((r) => r.id === GLOBAL_REGION)) {
        regions.push({ id: GLOBAL_REGION, priority: 0, owners: [], members: [], flags: {} });
      }
      const region = regions.find((r) => r.id === id?.toLowerCase());
      if (!region) throw new Failure(`There is no region called "${id ?? ""}". /rg list shows them.`);
      return region;
    };

    // ------------------------------------------------------------ the commands
    const subcommands: Record<string, (player: Player, args: string[]) => void> = {
      define(player, args) {
        const id = newId(args[0]);
        regions.push({ id, ...boxOf(player), priority: 0, owners: names(args.slice(1)), members: [], flags: {} });
        save();
        player.sendMessage(`Region ${id} defined.`, "green");
      },
      redefine(player, args) {
        const region = find(args[0]);
        if (region.id === GLOBAL_REGION) throw new Failure("The global region has no box.");
        Object.assign(region, boxOf(player));
        save();
        player.sendMessage(`Region ${region.id} now covers your selection.`, "green");
      },
      remove(player, args) {
        const region = find(args[0]);
        regions = regions.filter((r) => r !== region);
        save();
        player.sendMessage(`Region ${region.id} removed.`, "green");
      },
      list(player) {
        const lines = regions.map((r) => `${r.id}${r.priority !== 0 ? ` (priority ${r.priority})` : ""}`).sort();
        player.sendMessage(`Regions (${lines.length}): ${lines.join(", ") || "none yet"}`, "gold");
      },
      info(player, args) {
        const region = args[0] !== undefined ? find(args[0]) : regionHere(player);
        player.sendMessage(`Region ${region.id}, priority ${region.priority}`, "gold");
        if (region.min && region.max) player.sendMessage(`From ${region.min.x}, ${region.min.y}, ${region.min.z} to ${region.max.x}, ${region.max.y}, ${region.max.z}`, "yellow");
        player.sendMessage(`Owners: ${region.owners.join(", ") || "nobody"}`, "yellow");
        player.sendMessage(`Members: ${region.members.join(", ") || "nobody"}`, "yellow");
        const flags = Object.entries(region.flags).map(([flag, value]) => `${flag}: ${value}`);
        player.sendMessage(`Flags: ${flags.join(", ") || "none"}`, "yellow");
      },
      addowner: (player, args) => changeNames(player, args, "owners", true),
      removeowner: (player, args) => changeNames(player, args, "owners", false),
      addmember: (player, args) => changeNames(player, args, "members", true),
      removemember: (player, args) => changeNames(player, args, "members", false),
      flag(player, args) {
        const region = find(args[0]);
        const flag = args[1]?.toLowerCase() ?? "";
        const value = args.slice(2).join(" ").trim();
        const isRule = (ALLOW_DENY_FLAGS as readonly string[]).includes(flag);
        if (!isRule && !(TEXT_FLAGS as readonly string[]).includes(flag)) throw new Failure(`Unknown flag. The flags are: ${[...ALLOW_DENY_FLAGS, ...TEXT_FLAGS].join(", ")}`);
        if (value === "" || value.toLowerCase() === "none") {
          delete region.flags[flag];
          save();
          player.sendMessage(`Flag ${flag} removed from ${region.id}.`, "green");
          return;
        }
        if (isRule && value !== "allow" && value !== "deny") throw new Failure(`The flag ${flag} takes allow or deny.`);
        if (value.length > MAX_TEXT_LENGTH) throw new Failure(`The text can be at most ${MAX_TEXT_LENGTH} characters.`);
        region.flags[flag] = value;
        save();
        player.sendMessage(`Flag ${flag} of ${region.id} is now: ${value}`, "green");
      },
      setpriority(player, args) {
        const region = find(args[0]);
        const priority = Number(args[1]);
        if (!Number.isInteger(priority) || Math.abs(priority) > 1_000_000) throw new Failure("The priority must be a whole number.");
        region.priority = priority;
        save();
        player.sendMessage(`Region ${region.id} has priority ${priority}.`, "green");
      },
      bypass(player, args) {
        const choice = args[0]?.toLowerCase();
        if (choice !== undefined && choice !== "on" && choice !== "off") throw new Failure("Usage: /rg bypass [on|off]");
        const on = choice === undefined ? bypassOff.has(player.username.toLowerCase()) : choice === "on";
        if (on) bypassOff.delete(player.username.toLowerCase());
        else bypassOff.add(player.username.toLowerCase());
        player.sendMessage(on ? "You ignore the regions (operator bypass is on)." : "The regions apply to you too (bypass is off).", "green");
      },
    };

    /** Operators ignore the regions unless they turned that off to test them. */
    const bypassOff = new Set<string>();
    const bypasses = (player: Player): boolean => player.isOp && !bypassOff.has(player.username.toLowerCase());

    function newId(text: string | undefined): string {
      const id = text?.toLowerCase() ?? "";
      if (!validRegionId(id)) throw new Failure("The id is 1-32 letters, digits, - or _.");
      if (regions.some((r) => r.id === id)) throw new Failure(`There is already a region called ${id}. Use /rg redefine to change its box.`);
      return id;
    }

    function boxOf(player: Player): { min: Pos; max: Pos } {
      const region = selectionOf(player.username);
      if (!region) throw new Failure("Select the area first: use the wooden axe (//wand), or //pos1 and //pos2.");
      return { min: region.min, max: region.max };
    }

    function names(list: string[]): string[] {
      for (const name of list) if (!validPlayerName(name)) throw new Failure(`"${name}" is not a player name.`);
      return [...new Set(list.map((name) => name.toLowerCase()))];
    }

    function changeNames(player: Player, args: string[], who: "owners" | "members", add: boolean): void {
      const region = find(args[0]);
      if (region.id === GLOBAL_REGION && who === "owners") throw new Failure("The global region has no owners.");
      const list = names(args.slice(1));
      if (list.length === 0) throw new Failure("Say which players.");
      region[who] = add ? [...new Set([...region[who], ...list])] : region[who].filter((name) => !list.includes(name));
      save();
      player.sendMessage(`${region.id} ${who}: ${region[who].join(", ") || "nobody"}`, "green");
    }

    /** The region at the player's feet with the highest priority, for /rg info without an id. */
    function regionHere(player: Player): Region {
      const here = blockOf(player);
      const found = regions.filter((r) => r.id !== GLOBAL_REGION && contains(r, here)).sort((a, b) => b.priority - a.priority)[0];
      if (!found) throw new Failure("You are not inside a region. Give the id: /rg info <id>");
      return found;
    }

    for (const name of ["region", "rg"]) {
      api.registerCommand({
        name,
        description: "Protect areas of the world (WorldGuard)",
        usage: "/rg <define|remove|list|info|flag|...>",
        opOnly: true,
        run(player, args) {
          const handler = Object.hasOwn(subcommands, args[0]?.toLowerCase() ?? "") ? subcommands[args[0].toLowerCase()] : undefined;
          if (!handler) {
            for (const line of HELP) player.sendMessage(line, "gold");
            return;
          }
          try {
            handler(player, args.slice(1));
          } catch (err) {
            if (!(err instanceof Failure)) throw err;
            player.sendMessage(err.message, "red");
          }
        },
      });
    }

    // ------------------------------------------------------------ the rules at work
    const guardBuild = (action: BuildAction) => (event: { cancelled: boolean; player: Player; position: Pos }): void => {
      if (event.cancelled || bypasses(event.player)) return;
      const verdict = checkBuild(regions, event.player.username, event.position, action);
      if (verdict.allowed) return;
      event.cancelled = true;
      event.player.sendMessage(colorize(verdict.message), "red");
    };
    // Explosions leave the blocks of protected regions alone.
    api.on("explosion", (event) => {
      event.blocks = event.blocks.filter((pos) => explosionMayDestroy(regions, pos));
    });
    // Players cannot hurt each other where a region says pvp deny (looked up at the player who is hit).
    api.on("playerDamage", (event) => {
      if (event.cancelled || !event.attacker || event.attacker === event.player) return;
      if (!pvpAllowed(regions, blockOf(event.player))) event.cancelled = true;
    });
    api.on("blockBreak", guardBuild("block-break"));
    api.on("blockPlace", guardBuild("block-place"));

    // Where each player was (the block and the regions there), to notice walking in and out.
    const standing = new Map<string, { block: Pos; ids: Set<string> }>();
    const remember = (player: Player): void => {
      const block = blockOf(player);
      standing.set(player.username.toLowerCase(), { block, ids: regionIdsAt(regions, block) });
    };
    api.on("playerJoin", ({ player }) => remember(player));
    api.on("playerQuit", ({ player }) => standing.delete(player.username.toLowerCase()));

    api.on("playerMove", ({ player, from }) => {
      const key = player.username.toLowerCase();
      const before = standing.get(key);
      const block = blockOf(player);
      if (before && before.block.x === block.x && before.block.y === block.y && before.block.z === block.z) return;
      const ids = regionIdsAt(regions, block);
      const entered = [...ids].filter((id) => !before?.ids.has(id));
      const left = [...(before?.ids ?? [])].filter((id) => !ids.has(id));

      if (entered.length > 0 && !bypasses(player) && !checkEntry(regions, player.username, block)) {
        player.sendMessage("You are not allowed to go in there.", "red");
        player.teleport(from.x, from.y, from.z);
        return;
      }
      standing.set(key, { block, ids });
      for (const id of left) {
        const text = regions.find((r) => r.id === id)?.flags.farewell;
        if (text) player.sendMessage(colorize(text));
      }
      for (const id of entered) {
        const text = regions.find((r) => r.id === id)?.flags.greeting;
        if (text) player.sendMessage(colorize(text));
      }
    });
  },
};
