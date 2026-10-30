import fs from "node:fs";
import path from "node:path";
import type { Plugin, NpcDefinition } from "../types";
import type { Player } from "../../game/Player";
import { runCommand } from "../../game/commands";
import { runConsoleCommand } from "../../consoleCommands";
import { miniMessage } from "../../migrate/fancynpcs";
import {
  NPC_ACTIONS,
  EQUIPMENT_SLOTS,
  validNpcDocument,
  type NpcDocument,
  type SavedNpc,
  type SavedNpcAction,
  type NpcActionType,
} from "./npcData";

export const npcsPlugin: Plugin = {
  name: "npcs",
  version: "1.0.0",
  onEnable(api) {
    const file = path.resolve("plugins-data/npcs.json");
    if (fs.existsSync(file) && fs.statSync(file).size > 4 * 1024 * 1024)
      throw Error("npcs.json exceeds 4 MiB; refusing to overwrite");
    const fallback: NpcDocument = { version: 1, npcs: [] };
    let data = api.loadData(fallback, validNpcDocument);
    if (data === fallback && fs.existsSync(file))
      throw Error("Cannot load valid npcs.json; fix it before editing NPCs (file kept)");
    data = structuredClone(data);
    const owned = new Set<string>(),
      warned = new Set<string>();
    const cooldowns = new Map<string, Map<string, number>>();
    const warnOnce = (key: string, message: string) => {
      if (!warned.has(key)) {
        warned.add(key);
        api.logger.warn(message);
      }
    };
    const definition = (n: SavedNpc): NpcDefinition => ({
      id: n.id,
      position: { ...n.position },
      yaw: n.yaw,
      pitch: n.pitch,
      name: n.name,
      skin: n.skin ? { ...n.skin } : undefined,
      equipment: n.equipment ? structuredClone(n.equipment) : undefined,
      lookAtPlayers: n.lookAtPlayers,
      scale: n.scale,
      glowing: n.glowing,
    });
    const spawn = (n: SavedNpc) => {
      if (n.skinName && !n.skin)
        warnOnce(
          `skin:${n.id}`,
          `NPC ${n.id}: skinName requires a texture refresh; no Mojang lookup is performed.`,
        );
      for (const a of n.actions)
        if (!NPC_ACTIONS.includes(a.type))
          warnOnce(`action:${a.type}`, `Unsupported NPC action ${a.type}; skipping it.`);
      const npc = api.npcs.spawn(definition(n));
      if (npc) owned.add(n.id);
      return npc;
    };
    for (const n of data.npcs) spawn(n);
    const save = (next: NpcDocument) => {
      if (!validNpcDocument(next)) throw Error("Invalid NPC data or limits exceeded");
      api.saveData(next);
      data = next;
    };
    const change = (id: string, update: (n: SavedNpc) => void): SavedNpc => {
      const next = structuredClone(data),
        n = next.npcs.find((n) => n.id === id);
      if (!n) throw Error(`Unknown NPC ${id}`);
      update(n);
      save(next);
      return n;
    };
    const execute = (player: Player, a: SavedNpcAction) => {
      const text = a.value.replace(/\{player\}/g, player.username);
      switch (a.type) {
        case "player_command":
          runCommand(player, text.replace(/^\//, ""));
          break;
        case "console_command":
          runConsoleCommand(api.server, text);
          break;
        case "message":
          player.sendMessage(text);
          break;
        case "title": {
          const [title, ...subtitle] = text.split("|");
          player.sendTitle(title, subtitle.join("|"));
          break;
        }
        case "actionbar":
          player.sendActionBar(text);
          break;
        case "server":
          player.connectToServer(text.trim());
          break;
        case "teleport": {
          const pieces = text.trim().split(/\s+/);
          if (pieces.length !== 3 || pieces.some((p) => !Number.isFinite(Number(p)))) {
            warnOnce(
              `tp:${a.value}`,
              "NPC teleport requires three finite numeric coordinates; action skipped.",
            );
            break;
          }
          const [x, y, z] = pieces.map(Number);
          if (Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || y < 0 || y > 255) {
            warnOnce(`tp:${a.value}`, "NPC teleport outside the supported world; action skipped.");
            break;
          }
          player.teleport(x, y, z);
          break;
        }
        default:
          warnOnce(`action:${a.type}`, `Unsupported NPC action ${a.type}; skipping it.`);
      }
    };
    api.on("playerQuit", ({ player }) => cooldowns.delete(player.uuid));
    api.on("npcInteract", ({ player, npc, click }) => {
      if (!owned.has(npc.id)) return;
      const saved = data.npcs.find((n) => n.id === npc.id);
      if (!saved) return;
      const seen = new Set<string>();
      const actions = saved.actions.filter((a) => {
        if (a.click !== "any" && a.click !== click) return false;
        const key = JSON.stringify([a.type, a.value, a.delayTicks ?? 0]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!actions.length) return;
      const now = Date.now(),
        playerTimes = cooldowns.get(player.uuid) ?? new Map<string, number>();
      if (now < (playerTimes.get(saved.id) ?? 0)) return;
      playerTimes.set(saved.id, now + (saved.cooldownMs ?? 0));
      cooldowns.set(player.uuid, playerTimes);
      for (const action of actions) {
        const perform = () => {
          if (
            !owned.has(saved.id) ||
            !data.npcs.some((n) => n.id === saved.id) ||
            api.server.getPlayerByName(player.username) !== player
          )
            return;
          try {
            execute(player, action);
          } catch {
            warnOnce(
              `failure:${saved.id}:${action.type}`,
              `NPC ${saved.id}: ${action.type} failed; see command/server logs.`,
            );
          }
        };
        if (action.delayTicks) api.runLater(action.delayTicks, perform);
        else perform();
      }
    });
    if (
      !api.registerCommand({
        name: "npc",
        description: "Manage persistent NPCs",
        opOnly: true,
        usage: "/npc list|create|remove|tp|skin|name|equip|action",
        run(player, args) {
          try {
            const [sub, id, ...rest] = args;
            if (sub === "list" && args.length === 1) {
              player.sendMessage(
                `NPCs (${data.npcs.length}): ${data.npcs.map((n) => n.id).join(", ") || "(none)"}`,
              );
              return;
            }
            if (sub === "create" && id) {
              if (data.npcs.some((n) => n.id === id)) throw Error("That NPC id already exists");
              const n: SavedNpc = {
                id,
                position: { x: player.x, y: player.y, z: player.z },
                yaw: player.yaw,
                pitch: player.pitch,
                name: miniMessage(rest.join(" ") || id),
                actions: [],
              };
              save({ version: 1, npcs: [...data.npcs, n] });
              if (!spawn(n)) throw Error("Definition saved, but spawn failed; check the console");
            } else if (sub === "remove" && args.length === 2) {
              if (!data.npcs.some((n) => n.id === id)) throw Error("Unknown NPC");
              save({ version: 1, npcs: data.npcs.filter((n) => n.id !== id) });
              if (owned.delete(id)) api.npcs.get(id)?.remove();
            } else if (sub === "tp" && args.length === 2) {
              const n = change(id, (n) => {
                n.position = { x: player.x, y: player.y, z: player.z };
                n.yaw = player.yaw;
                n.pitch = player.pitch;
              });
              if (owned.has(id)) api.npcs.get(id)?.teleport(n.position, n.yaw, n.pitch);
            } else if (sub === "equip" && (rest.length === 2 || rest.length === 3)) {
              const [rawSlot, item, color] = rest;
              const slot = EQUIPMENT_SLOTS.find((slot) => slot.toLowerCase() === rawSlot.toLowerCase());
              if (!slot) throw Error("Equipment slot must be mainhand, offhand, head, chest, legs or feet");
              if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw Error("Color must be #rrggbb");
              if (item === "none" && color !== undefined) throw Error("none does not take a color");
              const n = change(id, (n) => {
                n.equipment ??= {};
                if (item === "none") delete n.equipment[slot];
                else
                  n.equipment[slot] = { item, ...(color ? { dyedColor: parseInt(color.slice(1), 16) } : {}) };
              });
              if (owned.has(id)) api.npcs.get(id)?.setEquipment(n.equipment);
            } else if (sub === "skin" && rest.length === 2) {
              const n = change(id, (n) => {
                n.skin = { value: rest[0], signature: rest[1] };
                delete n.skinName;
              });
              if (owned.has(id)) api.npcs.get(id)?.setSkin(n.skin);
            } else if (sub === "name" && rest.length > 0) {
              const n = change(id, (n) => {
                n.name = miniMessage(rest.join(" "));
              });
              if (owned.has(id)) api.npcs.get(id)?.setName(n.name!);
            } else if (sub === "action") {
              const [operation, npcId, ...values] = args.slice(1),
                target = data.npcs.find((n) => n.id === npcId);
              if (!target) throw Error("Unknown NPC");
              if (operation === "list" && values.length === 0) {
                player.sendMessage(
                  target.actions
                    .map(
                      (a, i) =>
                        `${i + 1}: ${a.click} ${a.type} ${a.value} (delay ${a.delayTicks ?? 0} ticks)`,
                    )
                    .join("\n") || "(no actions)",
                );
                return;
              }
              if (operation === "remove" && values.length === 1) {
                const index = Number(values[0]);
                if (!Number.isInteger(index) || index < 1 || index > target.actions.length)
                  throw Error("Action index must be in the list");
                change(npcId, (n) => {
                  n.actions.splice(index - 1, 1);
                });
              } else if (operation === "add" && values.length >= 3) {
                const [click, type, ...value] = values;
                if (!["left", "right", "any"].includes(click) || !NPC_ACTIONS.includes(type as NpcActionType))
                  throw Error(
                    "Use add <id> left|right|any player_command|console_command|message|title|actionbar|server|teleport <value>",
                  );
                let delayTicks: number | undefined;
                if (value.length >= 3 && value[value.length - 2] === "--delay") {
                  delayTicks = Number(value.pop());
                  value.pop();
                }
                change(npcId, (n) => {
                  n.actions.push({
                    click: click as SavedNpcAction["click"],
                    type: type as NpcActionType,
                    value: value.join(" "),
                    ...(delayTicks !== undefined ? { delayTicks } : {}),
                  });
                });
              } else throw Error("Use /npc action add|remove|list <id> ...");
            } else
              throw Error(
                "Use /npc list|create <id> [name]|remove <id>|tp <id>|skin <id> <value> <signature>|name <id> <text>|action add|remove|list <id> ...",
              );
            player.sendMessage("NPC change saved.", "green");
          } catch (error) {
            player.sendMessage(`NPC: ${error instanceof Error ? error.message : String(error)}`, "red");
          }
        },
      })
    )
      throw Error("/npc is already registered");
  },
};
