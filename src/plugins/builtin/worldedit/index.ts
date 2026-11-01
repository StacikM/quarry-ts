import type { Plugin } from "../../types";
import type { Player } from "../../../game/Player";
import { Block } from "../../../world/blocks";
import { stateForItem } from "../../../world/blockStates";
import { checkVolume, EditError, MAX_BLOCKS, posText, regionSize, regionVolume, type Pos, type Region } from "./common";
import { parseMask, parsePattern } from "./parse";
import { checkBallSize, checkRadius, cuboid, cylinder, directionFrom, MAX_HEIGHT, sphere, walls } from "./shapes";
import { applyChanges, ChangeSet, forgetSession, redo, regionBetween, sessionFor, undo, type Clipboard, type Session } from "./session";

/**
 * A small WorldEdit: select a box with a wooden axe (or //pos1 and //pos2) and fill, replace, copy, paste,
 * move, stack and undo. The command names are the ones of the real WorldEdit, and only operators can use them.
 * It is not the real plugin: no schematics, brushes or rotation, and edits stop at MAX_BLOCKS blocks.
 */

const WAND = "wooden_axe";
const GOOD = "light_purple";

const blockOf = (player: Player): Pos => ({ x: Math.floor(player.x), y: Math.floor(player.y), z: Math.floor(player.z) });

/** Splits "-h" style flags (single letters) from the other arguments. */
function readFlags(args: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const arg of args) {
    if (/^-[a-z]+$/i.test(arg)) for (const letter of arg.slice(1).toLowerCase()) flags.add(letter);
    else rest.push(arg);
  }
  return { flags, rest };
}

function wholeNumber(text: string | undefined, what: string, min = 1, max = 1_000_000): number {
  const value = Number(text);
  if (text === undefined || !Number.isInteger(value) || value < min || value > max) throw new EditError(`${what} must be a whole number from ${min} to ${max}.`);
  return value;
}

function decimal(text: string | undefined, what: string): number {
  const value = Number(text);
  if (text === undefined || !Number.isFinite(value)) throw new EditError(`${what} must be a number.`);
  return value;
}

function blocks(count: number): string {
  return `${count} block${count === 1 ? "" : "s"}`;
}

function selectedRegion(session: Session): Region {
  if (!session.pos1 || !session.pos2) throw new EditError("Select a region first: use the wooden axe (//wand), or //pos1 and //pos2.");
  return regionBetween(session.pos1, session.pos2);
}

/** Sets the corners to a box again after it was resized. */
function selectRegion(session: Session, region: Region): void {
  session.pos1 = { ...region.min };
  session.pos2 = { ...region.max };
}

/** The first solid block along the line of sight, up to 100 blocks away. */
function lookedAt(player: Player): Pos {
  const yaw = (player.yaw * Math.PI) / 180;
  const pitch = (player.pitch * Math.PI) / 180;
  const step = { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
  const eye = { x: player.x, y: player.y + 1.62, z: player.z };
  for (let distance = 0; distance <= 100; distance += 0.1) {
    const pos = { x: Math.floor(eye.x + step.x * distance), y: Math.floor(eye.y + step.y * distance), z: Math.floor(eye.z + step.z * distance) };
    if (player.server.world.getState(pos) !== Block.Air) return pos;
  }
  throw new EditError("There is no block in sight (within 100 blocks).");
}

export const worldEditPlugin: Plugin = {
  name: "worldedit",
  version: "1.0.0",
  onEnable(api) {
    const server = api.server;

    /** Registers a command that only operators can use, with mistakes of the player shown as red text. */
    function command(name: string, description: string, usage: string, run: (player: Player, args: string[], session: Session) => void): void {
      api.registerCommand({
        name: `/${name}`,
        description,
        usage,
        opOnly: true,
        run(player, args) {
          try {
            run(player, args, sessionFor(player.username));
          } catch (err) {
            if (!(err instanceof EditError)) throw err;
            player.sendMessage(err.message, "red");
          }
        },
      });
    }

    const heldState = (player: Player): (() => number | undefined) => () => {
      const held = player.hotbar[player.heldSlot];
      return held < 0 ? undefined : stateForItem(held);
    };

    /** Runs `fill` to plan an edit, places it and tells the player. */
    function edit(player: Player, session: Session, what: string, fill: (changes: ChangeSet) => void): void {
      const changes = new ChangeSet();
      fill(changes);
      player.sendMessage(`${what}: ${blocks(applyChanges(server, session, changes))} changed.`, GOOD);
    }

    // ------------------------------------------------------------ selecting
    command("wand", "Get the selection wand (a wooden axe)", "//wand", (player) => {
      if (player.give(WAND, 1) > 0) throw new EditError("Your inventory is full.");
      player.sendMessage("Left click a block with the wooden axe for the first corner, right click for the second.", GOOD);
    });

    const setCorner = (player: Player, session: Session, which: 1 | 2, pos: Pos): void => {
      if (which === 1) session.pos1 = pos;
      else session.pos2 = pos;
      const both = session.pos1 && session.pos2 ? ` (${blocks(regionVolume(regionBetween(session.pos1, session.pos2)))})` : "";
      player.sendMessage(`${which === 1 ? "First" : "Second"} position set to (${posText(pos)})${both}.`, GOOD);
    };
    command("pos1", "Set the first corner where you stand", "//pos1", (player, _args, session) => setCorner(player, session, 1, blockOf(player)));
    command("pos2", "Set the second corner where you stand", "//pos2", (player, _args, session) => setCorner(player, session, 2, blockOf(player)));
    command("hpos1", "Set the first corner to the block you look at", "//hpos1", (player, _args, session) => setCorner(player, session, 1, lookedAt(player)));
    command("hpos2", "Set the second corner to the block you look at", "//hpos2", (player, _args, session) => setCorner(player, session, 2, lookedAt(player)));

    const clearSelection = (player: Player, session: Session): void => {
      session.pos1 = undefined;
      session.pos2 = undefined;
      player.sendMessage("Selection cleared.", GOOD);
    };
    command("desel", "Clear your selection", "//desel", (player, _args, session) => clearSelection(player, session));
    command("sel", "Clear your selection", "//sel", (player, _args, session) => clearSelection(player, session));

    command("size", "Show the size of your selection and clipboard", "//size", (player, _args, session) => {
      const region = selectedRegion(session);
      const size = regionSize(region);
      player.sendMessage(`Selection: ${size.x} x ${size.y} x ${size.z}, ${blocks(regionVolume(region))}, from (${posText(region.min)}) to (${posText(region.max)}).`, GOOD);
      if (session.clipboard) {
        const clip = session.clipboard.size;
        player.sendMessage(`Clipboard: ${clip.x} x ${clip.y} x ${clip.z}, ${blocks(session.clipboard.states.length)}.`, GOOD);
      }
    });

    /** Moves the faces of the selection: grow or shrink it along a direction, or slide it. */
    const resizeCommand = (name: string, description: string, change: (region: Region, direction: Pos, amount: number) => Region): void => {
      command(name, description, `//${name} <blocks> [n|s|e|w|u|d|me]`, (player, args, session) => {
        const region = selectedRegion(session);
        if (name === "expand" && args[0]?.toLowerCase() === "vert") {
          selectRegion(session, { min: { ...region.min, y: 0 }, max: { ...region.max, y: 255 } });
          player.sendMessage("Selection expanded from the bottom of the world to the top.", GOOD);
          return;
        }
        const next = change(region, directionFrom(args[1], player), wholeNumber(args[0], "The number of blocks", 0, 10_000));
        selectRegion(session, next);
        player.sendMessage(`Selection is now ${posText(regionSize(next))} (${blocks(regionVolume(next))}).`, GOOD);
      });
    };
    resizeCommand("expand", "Make the selection bigger (or \"vert\": all the way up and down)", (region, d, n) => ({
      min: { x: region.min.x + Math.min(d.x, 0) * n, y: region.min.y + Math.min(d.y, 0) * n, z: region.min.z + Math.min(d.z, 0) * n },
      max: { x: region.max.x + Math.max(d.x, 0) * n, y: region.max.y + Math.max(d.y, 0) * n, z: region.max.z + Math.max(d.z, 0) * n },
    }));
    resizeCommand("contract", "Make the selection smaller from one side", (region, d, n) => {
      // The face that points in the direction moves back towards the other one, but never past it.
      const next = {
        min: { x: region.min.x - Math.min(d.x, 0) * n, y: region.min.y - Math.min(d.y, 0) * n, z: region.min.z - Math.min(d.z, 0) * n },
        max: { x: region.max.x - Math.max(d.x, 0) * n, y: region.max.y - Math.max(d.y, 0) * n, z: region.max.z - Math.max(d.z, 0) * n },
      };
      if (next.min.x > next.max.x || next.min.y > next.max.y || next.min.z > next.max.z) throw new EditError("That would make the selection disappear.");
      return next;
    });
    resizeCommand("shift", "Slide the selection", (region, d, n) => ({
      min: { x: region.min.x + d.x * n, y: region.min.y + d.y * n, z: region.min.z + d.z * n },
      max: { x: region.max.x + d.x * n, y: region.max.y + d.y * n, z: region.max.z + d.z * n },
    }));

    // The wand: left click picks the first corner, right click the second (and the block is left alone).
    api.on("playerInteract", (event) => {
      if (event.item !== WAND || !event.player.isOp || event.cancelled) return;
      event.cancelled = true;
      try {
        setCorner(event.player, sessionFor(event.player.username), event.click === "left" ? 1 : 2, { ...event.position });
      } catch (err) {
        if (!(err instanceof EditError)) throw err;
        event.player.sendMessage(err.message, "red");
      }
    });
    api.on("playerQuit", ({ player }) => forgetSession(player.username));

    // ------------------------------------------------------------ filling
    command("set", "Fill the selection with a block or pattern", "//set <pattern>", (player, args, session) => {
      const region = selectedRegion(session);
      checkVolume(region);
      const pick = parsePattern(args.join(" "), heldState(player));
      edit(player, session, "Set", (changes) => cuboid(region, (x, y, z) => changes.set(x, y, z, pick())));
    });

    command("replace", "Replace blocks in the selection", "//replace [<from>] <to>", (player, args, session) => {
      const region = selectedRegion(session);
      checkVolume(region);
      if (args.length < 1 || args.length > 2) throw new EditError("Usage: //replace [<from>] <to>");
      const pick = parsePattern(args[args.length - 1], heldState(player));
      const wanted = args.length === 2 ? parseMask(args[0]) : (state: number) => state !== Block.Air;
      edit(player, session, "Replace", (changes) =>
        cuboid(region, (x, y, z) => {
          if (wanted(server.world.getState({ x, y, z }))) changes.set(x, y, z, pick());
        }),
      );
    });

    command("walls", "Build the four walls of the selection", "//walls <pattern>", (player, args, session) => {
      const region = selectedRegion(session);
      checkVolume(region);
      const pick = parsePattern(args.join(" "), heldState(player));
      edit(player, session, "Walls", (changes) => walls(region, (x, y, z) => changes.set(x, y, z, pick())));
    });

    for (const hollow of [false, true]) {
      const prefix = hollow ? "h" : "";
      command(`${prefix}sphere`, `Make a ${hollow ? "hollow " : ""}ball around you`, `//${prefix}sphere <pattern> <radius>`, (player, args, session) => {
        const { flags, rest } = readFlags(args);
        const radius = decimal(rest[1], "The radius");
        checkRadius(radius);
        const isHollow = hollow || flags.has("h");
        checkBallSize(radius, isHollow);
        const pick = parsePattern(rest[0] ?? "", heldState(player));
        edit(player, session, "Sphere", (changes) => sphere(blockOf(player), radius, isHollow, (x, y, z) => changes.set(x, y, z, pick())));
      });
      command(`${prefix}cyl`, `Make a ${hollow ? "hollow " : ""}round column up from your feet`, `//${prefix}cyl <pattern> <radius> [height]`, (player, args, session) => {
        const { flags, rest } = readFlags(args);
        const radius = decimal(rest[1], "The radius");
        checkRadius(radius);
        const height = rest[2] === undefined ? 1 : wholeNumber(rest[2], "The height", 1, MAX_HEIGHT);
        const isHollow = hollow || flags.has("h");
        if (!isHollow && Math.PI * (radius + 0.5) ** 2 * height > MAX_BLOCKS) throw new EditError(`That cylinder has too many blocks. The limit is ${MAX_BLOCKS} per edit.`);
        const pick = parsePattern(rest[0] ?? "", heldState(player));
        edit(player, session, "Cylinder", (changes) => cylinder(blockOf(player), radius, height, isHollow, (x, y, z) => changes.set(x, y, z, pick())));
      });
    }

    command("count", "Count blocks in the selection", "//count <block>[,<block>...]", (player, args, session) => {
      const region = selectedRegion(session);
      checkVolume(region);
      const wanted = parseMask(args.join(" "));
      let found = 0;
      cuboid(region, (x, y, z) => {
        if (wanted(server.world.getState({ x, y, z }))) found++;
      });
      player.sendMessage(`Counted ${found}.`, GOOD);
    });

    // ------------------------------------------------------------ copying
    /** Reads the blocks of a region into a clipboard, remembering where the player stands relative to it. */
    const readRegion = (player: Player, region: Region): Clipboard => {
      checkVolume(region);
      const size = regionSize(region);
      const states = new Uint16Array(size.x * size.y * size.z);
      let next = 0;
      cuboid(region, (x, y, z) => {
        states[next++] = server.world.getState({ x, y, z });
      });
      const here = blockOf(player);
      return { size, offset: { x: region.min.x - here.x, y: region.min.y - here.y, z: region.min.z - here.z }, states };
    };

    /** Plans the clipboard's blocks with its corner at `origin`. */
    const plan = (clipboard: Clipboard, origin: Pos, changes: ChangeSet, skipAir: boolean): void => {
      let next = 0;
      for (let y = 0; y < clipboard.size.y; y++) {
        for (let z = 0; z < clipboard.size.z; z++) {
          for (let x = 0; x < clipboard.size.x; x++) {
            const state = clipboard.states[next++];
            if (!(skipAir && state === Block.Air)) changes.set(origin.x + x, origin.y + y, origin.z + z, state);
          }
        }
      }
    };

    command("copy", "Copy the selection", "//copy", (player, _args, session) => {
      session.clipboard = readRegion(player, selectedRegion(session));
      player.sendMessage(`${blocks(session.clipboard.states.length)} copied.`, GOOD);
    });

    command("cut", "Copy the selection, then clear it", "//cut [<pattern to leave>]", (player, args, session) => {
      const region = selectedRegion(session);
      const clipboard = readRegion(player, region);
      const leave = parsePattern(args.length > 0 ? args.join(" ") : "air", heldState(player));
      edit(player, session, "Cut", (changes) => cuboid(region, (x, y, z) => changes.set(x, y, z, leave())));
      session.clipboard = clipboard;
      player.sendMessage(`${blocks(clipboard.states.length)} copied to the clipboard.`, GOOD);
    });

    command("paste", "Paste the clipboard where you stand", "//paste [-a]", (player, args, session) => {
      if (!session.clipboard) throw new EditError("Your clipboard is empty. Use //copy first.");
      const { flags } = readFlags(args);
      const here = blockOf(player);
      const origin = { x: here.x + session.clipboard.offset.x, y: here.y + session.clipboard.offset.y, z: here.z + session.clipboard.offset.z };
      edit(player, session, "Pasted", (changes) => plan(session.clipboard!, origin, changes, flags.has("a")));
    });

    command("clearclipboard", "Forget what you copied", "//clearclipboard", (player, _args, session) => {
      session.clipboard = undefined;
      player.sendMessage("Clipboard cleared.", GOOD);
    });

    command("move", "Move the contents of the selection", "//move <blocks> [direction] [<pattern to leave>]", (player, args, session) => {
      const region = selectedRegion(session);
      const distance = wholeNumber(args[0], "The distance", 1, 10_000);
      const direction = directionFrom(args[1], player);
      const leave = parsePattern(args.slice(2).join(" ") || "air", heldState(player));
      const clipboard = readRegion(player, region); // not the player's clipboard: moving is not copying
      const origin = { x: region.min.x + direction.x * distance, y: region.min.y + direction.y * distance, z: region.min.z + direction.z * distance };
      edit(player, session, "Moved", (changes) => {
        cuboid(region, (x, y, z) => changes.set(x, y, z, leave()));
        plan(clipboard, origin, changes, false);
      });
    });

    command("stack", "Repeat the selection next to itself", "//stack <times> [direction]", (player, args, session) => {
      const region = selectedRegion(session);
      const times = wholeNumber(args[0], "The number of copies", 1, 1000);
      const direction = directionFrom(args[1], player);
      const size = regionSize(region);
      const clipboard = readRegion(player, region);
      edit(player, session, "Stacked", (changes) => {
        for (let copy = 1; copy <= times; copy++) {
          const origin = {
            x: region.min.x + direction.x * size.x * copy,
            y: region.min.y + direction.y * size.y * copy,
            z: region.min.z + direction.z * size.z * copy,
          };
          plan(clipboard, origin, changes, false);
        }
      });
    });

    // ------------------------------------------------------------ undo
    command("undo", "Take back your last edit", "//undo [times]", (player, args, session) => {
      const done = undo(server, session, args[0] === undefined ? 1 : wholeNumber(args[0], "The number of edits", 1, 100));
      if (done.edits === 0) throw new EditError("There is nothing to undo.");
      player.sendMessage(`Undid ${done.edits} edit${done.edits === 1 ? "" : "s"} (${blocks(done.blocks)}).`, GOOD);
    });
    command("redo", "Put back what you undid", "//redo [times]", (player, args, session) => {
      const done = redo(server, session, args[0] === undefined ? 1 : wholeNumber(args[0], "The number of edits", 1, 100));
      if (done.edits === 0) throw new EditError("There is nothing to redo.");
      player.sendMessage(`Redid ${done.edits} edit${done.edits === 1 ? "" : "s"} (${blocks(done.blocks)}).`, GOOD);
    });
  },
};
