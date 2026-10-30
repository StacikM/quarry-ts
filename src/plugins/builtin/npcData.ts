import type { NpcDefinition } from "../types";
import { itemId } from "../../world/blockStates";
export const EQUIPMENT_SLOTS = ["mainHand", "offHand", "head", "chest", "legs", "feet"] as const;
export function validEquipment(equipment: unknown): boolean {
  if (equipment === undefined) return true;
  if (!equipment || typeof equipment !== "object" || Array.isArray(equipment)) return false;
  return Object.entries(equipment).every(([slot, value]) => {
    if (
      !EQUIPMENT_SLOTS.includes(slot as (typeof EQUIPMENT_SLOTS)[number]) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return false;
    const stack = value as Record<string, unknown>;
    return (
      Object.keys(stack).every((key) => key === "item" || key === "dyedColor") &&
      typeof stack.item === "string" &&
      itemId(stack.item) !== undefined &&
      itemId(stack.item) !== 0 &&
      (stack.dyedColor === undefined ||
        (typeof stack.dyedColor === "number" &&
          Number.isInteger(stack.dyedColor) &&
          stack.dyedColor >= 0 &&
          stack.dyedColor <= 0xffffff))
    );
  });
}
export const NPC_ACTIONS = [
  "player_command",
  "console_command",
  "message",
  "title",
  "actionbar",
  "server",
  "teleport",
] as const;
export type NpcActionType = (typeof NPC_ACTIONS)[number];
export interface SavedNpcAction {
  click: "left" | "right" | "any";
  type: NpcActionType;
  value: string;
  delayTicks?: number;
}
export interface SavedNpc extends NpcDefinition {
  actions: SavedNpcAction[];
  cooldownMs?: number;
  skinName?: string;
  leftovers?: Record<string, unknown>;
}
export interface NpcDocument {
  version: 1;
  npcs: SavedNpc[];
}
export const NPC_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export function validNpcDocument(value: unknown): value is NpcDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as NpcDocument;
  if (doc.version !== 1 || !Array.isArray(doc.npcs) || doc.npcs.length > 1000) return false;
  const ids = new Set<string>();
  return doc.npcs.every((n) => {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !NPC_ID.test(n.id) || ids.has(n.id))
      return false;
    ids.add(n.id);
    if (!validEquipment(n.equipment)) return false;
    if (!n.position || ![n.position.x, n.position.y, n.position.z].every(Number.isFinite)) return false;
    if (
      Math.abs(n.position.x) > 30_000_000 ||
      Math.abs(n.position.z) > 30_000_000 ||
      n.position.y < 0 ||
      n.position.y > 255
    )
      return false;
    if (
      [n.yaw, n.pitch, n.scale, n.cooldownMs].some(
        (v) => v !== undefined && (typeof v !== "number" || !Number.isFinite(v)),
      )
    )
      return false;
    if (n.scale !== undefined && (n.scale < 0.0625 || n.scale > 16)) return false;
    if (n.cooldownMs !== undefined && (n.cooldownMs < 0 || n.cooldownMs > 86_400_000)) return false;
    if (n.name !== undefined && (typeof n.name !== "string" || n.name.length > 256)) return false;
    if (n.skinName !== undefined && (typeof n.skinName !== "string" || n.skinName.length > 32767))
      return false;
    if ([n.glowing, n.lookAtPlayers].some((v) => v !== undefined && typeof v !== "boolean")) return false;
    if (
      n.skin &&
      (typeof n.skin.value !== "string" ||
        n.skin.value.length === 0 ||
        n.skin.value.length > 32767 ||
        (n.skin.signature !== undefined &&
          (typeof n.skin.signature !== "string" || n.skin.signature.length > 1024)))
    )
      return false;
    return (
      Array.isArray(n.actions) &&
      n.actions.length <= 100 &&
      n.actions.every(
        (a) =>
          a &&
          ["left", "right", "any"].includes(a.click) &&
          typeof a.type === "string" &&
          typeof a.value === "string" &&
          a.value.length <= 32767 &&
          (a.delayTicks === undefined ||
            (Number.isInteger(a.delayTicks) && a.delayTicks >= 0 && a.delayTicks <= 72000)),
      )
    );
  });
}
