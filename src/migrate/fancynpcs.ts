import { parseYaml } from "../util/yaml";
import {
  NPC_ID,
  validNpcDocument,
  type NpcDocument,
  type SavedNpc,
  type SavedNpcAction,
  type NpcActionType,
} from "../plugins/builtin/npcData";
import { itemId } from "../world/blockStates";

const colors: Record<string, string> = {
  black: "0",
  dark_blue: "1",
  dark_green: "2",
  dark_aqua: "3",
  dark_red: "4",
  dark_purple: "5",
  gold: "6",
  gray: "7",
  grey: "7",
  dark_gray: "8",
  dark_grey: "8",
  blue: "9",
  green: "a",
  aqua: "b",
  red: "c",
  light_purple: "d",
  yellow: "e",
  white: "f",
  obfuscated: "k",
  bold: "l",
  strikethrough: "m",
  underlined: "n",
  underline: "n",
  italic: "o",
  reset: "r",
};
const hex = (color: string) =>
  /^#[\da-f]{6}$/i.test(color)
    ? "§x" +
      color
        .slice(1)
        .split("")
        .map((c) => "§" + c)
        .join("")
    : colors[color]
      ? "§" + colors[color]
      : "";
/** Approximate MiniMessage formatting only. No click/hover events or command execution. */
export function miniMessage(text: string): string {
  const stack: { tag: string; code: string }[] = [];
  return text.replace(/&([0-9a-fk-or])/gi, "§$1").replace(/<([^>]+)>/g, (_, raw: string) => {
    const tag = raw.toLowerCase();
    if (tag === "empty") return "";
    if (tag === "newline" || tag === "br") return "\n";
    if (tag === "reset") {
      stack.length = 0;
      return "§r";
    }
    if (tag.startsWith("/")) {
      const index = stack.map((s) => s.tag).lastIndexOf(tag.slice(1));
      if (index < 0) return "";
      stack.splice(index);
      return "§r" + stack.map((s) => s.code).join("");
    }
    const color = tag.startsWith("gradient:")
      ? tag.split(":")[1].replace(/['"]/g, "")
      : tag.startsWith("color:") || tag.startsWith("colour:")
        ? tag.split(":")[1]
        : tag;
    const code = hex(color);
    if (code) {
      stack.push({ tag: tag.split(":")[0], code });
      return code;
    }
    return "";
  });
}
const record = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
const substitutions = (text: string): string => text.replace(/%player_name%|%player%/g, "{player}");
export interface MigrationResult {
  data: NpcDocument;
  report: { migrated: number; skipped: string[]; unsupported: string[]; warnings: string[] };
}
export function migrateFancyNpcs(yaml: string): MigrationResult {
  const root = record(parseYaml(yaml));
  if (!root.npcs || typeof root.npcs !== "object" || Array.isArray(root.npcs))
    throw Error("FancyNpcs input must contain a top-level npcs map");
  const data: NpcDocument = { version: 1, npcs: [] };
  const report: MigrationResult["report"] = { migrated: 0, skipped: [], unsupported: [], warnings: [] };
  for (const [sourceId, raw] of Object.entries(root.npcs)) {
    if (data.npcs.length >= 1000) {
      report.skipped.push(`${sourceId}: NPC limit 1000 exceeded`);
      continue;
    }
    const n = record(raw),
      type = String(n.type ?? "PLAYER").toUpperCase();
    if (type !== "PLAYER") {
      report.skipped.push(`${sourceId}: non-player type ${type}`);
      continue;
    }
    if (!NPC_ID.test(sourceId)) {
      report.skipped.push(`${sourceId}: id must be 1-64 letters/digits/._-`);
      continue;
    }
    const location = record(n.location),
      skin = record(n.skin);
    const npc: SavedNpc = {
      id: sourceId,
      position: { x: location.x, y: location.y, z: location.z },
      yaw: location.yaw ?? 0,
      pitch: location.pitch ?? 0,
      name: miniMessage(String(n.displayName ?? n.name ?? "")),
      lookAtPlayers: n.turnToPlayer === true,
      glowing: n.glowing === true,
      scale: n.scale ?? 1,
      actions: [],
      cooldownMs: Number(n.interactionCooldown ?? 0) * 1000,
      leftovers: { ...n },
    };
    // Keep source identity/world/unsupported flags; remove only represented fields.
    for (const key of ["displayName", "type", "turnToPlayer", "glowing", "scale", "interactionCooldown"])
      delete npc.leftovers![key];
    if (typeof skin.value === "string" && skin.value)
      npc.skin = {
        value: skin.value,
        ...(typeof skin.signature === "string" ? { signature: skin.signature } : {}),
      };
    const skinName = skin.identifier ?? skin.uuid;
    if (typeof skinName === "string" && skinName) npc.skinName = skinName;
    if (npc.skinName && !npc.skin)
      report.warnings.push(`${sourceId}: skin ${npc.skinName} needs refresh; no embedded texture supplied`);
    if (location.world)
      report.warnings.push(
        `${sourceId}: source world ${location.world}; Quarry uses one world, coordinates kept`,
      );
    if (npc.scale !== 1)
      report.warnings.push(`${sourceId}: scale saved but not yet applied by the current NPC core`);
    if (n.spawnEntity === false) {
      report.skipped.push(`${sourceId}: spawnEntity=false (hidden NPC)`);
      continue;
    }
    const slots = {
      MAINHAND: "mainHand",
      OFFHAND: "offHand",
      HEAD: "head",
      CHEST: "chest",
      LEGS: "legs",
      FEET: "feet",
    } as const;
    if (n.equipment !== undefined) {
      npc.equipment = {};
      for (const [sourceSlot, rawStack] of Object.entries(record(n.equipment))) {
        const slot = slots[sourceSlot as keyof typeof slots],
          stack = record(rawStack);
        if (!slot) {
          report.warnings.push(`${sourceId}: ignored unknown equipment slot ${sourceSlot}`);
          continue;
        }
        if (Object.keys(stack).length === 0) continue;
        if (typeof stack.id !== "string" || itemId(stack.id) === undefined) {
          report.warnings.push(`${sourceId}: ignored equipment ${sourceSlot} with missing/unknown item id`);
          continue;
        }
        if (itemId(stack.id) === 0) continue;
        npc.equipment[slot] = { item: stack.id };
        for (const [component, value] of Object.entries(record(stack.components))) {
          if (component !== "minecraft:dyed_color") {
            report.warnings.push(`${sourceId}: ignored ${sourceSlot} component ${component}`);
            continue;
          }
          const rgb =
            typeof value === "number"
              ? value
              : typeof value === "string" && /^\d+$/.test(value)
                ? Number(value)
                : NaN;
          if (!Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff)
            report.warnings.push(`${sourceId}: ignored invalid ${sourceSlot} dyed_color`);
          else npc.equipment[slot]!.dyedColor = rgb;
        }
      }
    }
    for (const key of [
      "showInTab",
      "collidable",
      "glowingColor",
      "attributes",
      "visibility_distance",
      "mirrorSkin",
    ]) {
      if (n[key] !== undefined)
        report.warnings.push(`${sourceId}: ${key} retained in leftovers; not implemented by NPC contract`);
    }
    const append = (click: SavedNpcAction["click"], action: string, value: unknown, delayTicks = 0) => {
      const aliases: Record<string, NpcActionType> = {
        player_command: "player_command",
        console_command: "console_command",
        message: "message",
        send_to_server: "server",
        title: "title",
        actionbar: "actionbar",
        teleport: "teleport",
      };
      const mapped = aliases[action.toLowerCase()];
      if (!mapped) {
        report.unsupported.push(`${sourceId}: ${action} (${click})`);
        return;
      }
      if (typeof value !== "string" && typeof value !== "number") {
        report.unsupported.push(`${sourceId}: ${action} has non-text value`);
        return;
      }
      const text = substitutions(String(value));
      npc.actions.push({
        click,
        type: mapped,
        value: ["message", "title", "actionbar"].includes(mapped) ? miniMessage(text) : text,
        ...(delayTicks ? { delayTicks } : {}),
      });
    };
    const legacy = (key: string, singular: string, action: string) => {
      // The newer loader replaces its migrated ANY_CLICK list with the stored one.
      if (Object.keys(record(n.actions)).some((k) => k.toUpperCase() === "ANY_CLICK")) return;
      const values = Array.isArray(n[key]) ? n[key] : n[singular] === undefined ? [] : [n[singular]];
      for (const value of values) append("any", action, value);
    };
    legacy("playerCommands", "playerCommand", "player_command");
    legacy("serverCommands", "serverCommand", "console_command");
    if (n.sendMessagesRandomly === true)
      report.unsupported.push(
        `${sourceId}: random legacy messages preserved, not expanded into multiple messages`,
      );
    else legacy("messages", "message", "message");
    if (Array.isArray(n.actions))
      report.unsupported.push(
        `${sourceId}: actions is a list, not the verified trigger map; retained without executing`,
      );
    for (const [trigger, rawActions] of Object.entries(record(n.actions))) {
      const clicks: Record<string, SavedNpcAction["click"]> = {
        ANY_CLICK: "any",
        LEFT_CLICK: "left",
        RIGHT_CLICK: "right",
      };
      const click = clicks[trigger.toUpperCase()];
      if (!click) {
        report.unsupported.push(`${sourceId}: trigger ${trigger}`);
        continue;
      }
      const actions = Array.isArray(rawActions)
        ? rawActions
        : Object.entries(record(rawActions))
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, v]) => v);
      if (
        actions.some((a) =>
          ["need_permission", "execute_random_action", "block_until_done"].includes(
            String(record(a).action).toLowerCase(),
          ),
        )
      ) {
        report.unsupported.push(
          `${sourceId}: ${trigger} chain contains unsupported permission/control flow; entire chain retained, not executed`,
        );
        continue;
      }
      let delay = 0;
      for (const action of actions) {
        const a = record(action),
          kind = String(a.action ?? a.type ?? "");
        if (kind.toLowerCase() === "wait") {
          const seconds = Number(a.value);
          if (!Number.isInteger(seconds) || seconds < 0 || delay + seconds * 20 > 72000) {
            report.unsupported.push(`${sourceId}: invalid/unbounded wait; rest of ${trigger} skipped`);
            break;
          }
          delay += seconds * 20;
        } else append(click, kind, a.value, delay);
      }
    }
    if (!validNpcDocument({ version: 1, npcs: [npc] })) {
      report.skipped.push(`${sourceId}: invalid/out-of-range coordinates, scale, skin, cooldown or actions`);
      continue;
    }
    data.npcs.push(npc);
  }
  report.migrated = data.npcs.length;
  return { data, report };
}
