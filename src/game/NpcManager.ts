import { randomUUID } from "node:crypto";
import type { MinecraftServer } from "./Server";
import type { Player } from "./Player";
import type { Npc, NpcApi, NpcDefinition, NpcEquipment, SkinData } from "../plugins/types";
import { itemId } from "../world/blockStates";
import {
  ARMOR_STAND_ENTITY_TYPE,
  PLAYER_ENTITY_TYPE,
  EQUIPMENT_SLOTS,
  destroyEntities,
  entityEquipment,
  entityMetadata,
  entityPositionSync,
  headRotation,
  npcListAdd,
  npcListRemove,
  removeTeam,
  spawnEntity,
  teamWithHiddenNames,
} from "../protocol/clientbound";
import { logger } from "../util/logger";

/**
 * NPCs: fake players that stand in the world, with a skin and a name above their head.
 *
 * A player-shaped NPC needs three things on every client: an entry in the tab list (that is
 * where its skin lives; it is marked "not listed" so nobody sees it there), a team that hides
 * the made-up profile name above its head, and the entity itself. The text that people read is
 * an invisible armor stand with a custom name, standing where the name tag would be.
 */

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_COORDINATE = 30_000_000;
/** Height of the name tag above the NPC's feet. */
const NAME_HEIGHT = 1.8;
/** An NPC with lookAtPlayers turns to players closer than this (blocks). */
const LOOK_DISTANCE = 8;
const LOOK_EVERY_TICKS = 4;

/** Entity data field numbers. Entity: 0 flags, 2 custom name, 3 name shown. Player: 17 skin layers. Armor stand: 15 flags. */
const META = { flags: 0, customName: 2, nameVisible: 3, playerSkinLayers: 17, armorStandFlags: 15 } as const;
const FLAG_GLOWING = 0x40;
const FLAG_INVISIBLE = 0x20;
const ALL_SKIN_LAYERS = 0x7f;
const ARMOR_STAND_SMALL_MARKER = 0x01 | 0x10;

class NpcEntity implements Npc {
  readonly entityId: number;
  /** The armor stand that carries the name, or null while there is no name. */
  nameEntityId: number | null = null;
  readonly uuid = randomUUID();
  readonly nameStandUuid = randomUUID();
  /** What the client calls this fake player (never shown, but it must be unique and at most 16 characters). */
  readonly profileName: string;
  readonly teamName: string;
  /** What each player was last shown, so we only send turns that change something. */
  readonly turned = new Map<number, { yaw: number; pitch: number }>();
  definition: NpcDefinition;

  constructor(
    private readonly manager: NpcManager,
    readonly owner: string,
    definition: NpcDefinition,
    entityId: number,
    serial: number,
  ) {
    this.definition = definition;
    this.entityId = entityId;
    this.profileName = `qn_${serial.toString(36)}`;
    this.teamName = `qn${serial.toString(36)}`;
  }

  get id(): string {
    return this.definition.id;
  }
  teleport(position: { x: number; y: number; z: number }, yaw?: number, pitch?: number): void {
    this.manager.teleport(this, position, yaw, pitch);
  }
  setName(name: string): void {
    this.manager.setName(this, name);
  }
  setSkin(skin: SkinData | undefined): void {
    this.manager.setSkin(this, skin);
  }
  setEquipment(equipment: NpcEquipment | undefined): void {
    this.manager.setEquipment(this, equipment);
  }
  remove(): void {
    this.manager.remove(this);
  }
}

export class NpcManager {
  private readonly npcs = new Map<string, NpcEntity>();
  /** The NPC an entity number belongs to (the NPC itself and its name stand). */
  private readonly byEntity = new Map<number, NpcEntity>();
  private serial = 0;

  constructor(private readonly server: MinecraftServer) {}

  /** The part of the API a plugin gets. Everything it spawns is removed with `removeOwned` when it is disabled. */
  forOwner(owner: string): NpcApi {
    return {
      spawn: (definition) => this.spawn(owner, definition),
      get: (id) => this.npcs.get(id),
      list: () => [...this.npcs.values()],
    };
  }

  removeOwned(owner: string): void {
    for (const npc of [...this.npcs.values()]) if (npc.owner === owner) this.remove(npc);
  }

  /** Server shutdown or tests: nothing is left behind. */
  removeAll(): void {
    for (const npc of [...this.npcs.values()]) this.remove(npc);
  }

  spawn(owner: string, definition: NpcDefinition): Npc | null {
    const problem = validate(definition);
    if (problem) {
      logger.warn(`[${owner}] Cannot spawn NPC ${JSON.stringify((definition as { id?: unknown })?.id)}: ${problem}`);
      return null;
    }
    if (this.npcs.has(definition.id)) {
      logger.warn(`[${owner}] Cannot spawn NPC "${definition.id}": that id is already used`);
      return null;
    }
    const copy: NpcDefinition = { ...definition, position: { ...definition.position }, skin: definition.skin ? { ...definition.skin } : undefined };
    const npc = new NpcEntity(this, owner, copy, this.server.allocateEntityId(), ++this.serial);
    if (copy.name) npc.nameEntityId = this.server.allocateEntityId();
    this.npcs.set(copy.id, npc);
    this.byEntity.set(npc.entityId, npc);
    if (npc.nameEntityId !== null) this.byEntity.set(npc.nameEntityId, npc);
    for (const viewer of this.server.getOnlinePlayers()) this.showTo(npc, viewer);
    return npc;
  }

  /** A player just joined: they get to see every NPC. */
  showAllTo(player: Player): void {
    for (const npc of this.npcs.values()) this.showTo(npc, player);
  }

  forgetPlayer(player: Player): void {
    for (const npc of this.npcs.values()) npc.turned.delete(player.entityId);
  }

  /** The player hit ("left") or right-clicked ("right") an entity. Returns whether it was one of ours. */
  handleInteract(player: Player, entityId: number, click: "left" | "right", sneaking: boolean): boolean {
    const npc = this.byEntity.get(entityId);
    if (!npc) return false;
    this.server.plugins.events.emit("npcInteract", { player, npc, click, sneaking });
    return true;
  }

  /** Every few ticks: NPCs that look at players turn towards the ones who are close. */
  tick(tickCount: number): void {
    if (tickCount % LOOK_EVERY_TICKS !== 0 || this.npcs.size === 0) return;
    const players = this.server.getOnlinePlayers();
    for (const npc of this.npcs.values()) {
      if (!npc.definition.lookAtPlayers) continue;
      const { x, y, z } = npc.definition.position;
      const homeYaw = npc.definition.yaw ?? 0;
      const homePitch = npc.definition.pitch ?? 0;
      for (const player of players) {
        const dx = player.x - x;
        const dy = player.y - y;
        const dz = player.z - z;
        const flat = Math.hypot(dx, dz);
        const last = npc.turned.get(player.entityId);
        if (flat > LOOK_DISTANCE || Math.abs(dy) > LOOK_DISTANCE) {
          if (last) {
            npc.turned.delete(player.entityId); // they walked away: face the way it was placed again
            this.turnFor(npc, player, homeYaw, homePitch);
          }
          continue;
        }
        const yaw = flat < 0.01 ? homeYaw : (-Math.atan2(dx, dz) * 180) / Math.PI;
        const pitch = (-Math.atan2(dy, Math.max(flat, 0.01)) * 180) / Math.PI;
        const shown = last ?? { yaw: homeYaw, pitch: homePitch }; // before it first turned, it faces the way it was placed
        if (Math.abs(angleDifference(shown.yaw, yaw)) < 2 && Math.abs(shown.pitch - pitch) < 2) continue;
        npc.turned.set(player.entityId, { yaw, pitch });
        this.turnFor(npc, player, yaw, pitch);
      }
    }
  }

  // ------------------------------------------------------------ changes

  teleport(npc: NpcEntity, position: { x: number; y: number; z: number }, yaw?: number, pitch?: number): void {
    if (!isCoordinates(position)) return;
    npc.definition = { ...npc.definition, position: { ...position }, yaw: yaw ?? npc.definition.yaw, pitch: pitch ?? npc.definition.pitch };
    npc.turned.clear();
    const { x, y, z } = npc.definition.position;
    for (const viewer of this.server.getOnlinePlayers()) {
      viewer.send(entityPositionSync(npc.entityId, x, y, z, npc.definition.yaw ?? 0, npc.definition.pitch ?? 0));
      viewer.send(headRotation(npc.entityId, npc.definition.yaw ?? 0));
      if (npc.nameEntityId !== null) viewer.send(entityPositionSync(npc.nameEntityId, x, y + NAME_HEIGHT, z, 0, 0));
    }
  }

  setName(npc: NpcEntity, name: string): void {
    if (typeof name !== "string" || name.length > 256) return;
    const had = npc.nameEntityId !== null;
    const wants = name !== "";
    npc.definition = { ...npc.definition, name };
    if (had && wants) {
      for (const viewer of this.server.getOnlinePlayers()) viewer.send(entityMetadata(npc.nameEntityId!, [{ index: META.customName, type: "optionalComponent", value: { text: name } }]));
    } else {
      this.respawn(npc, () => {
        if (had && npc.nameEntityId !== null) this.byEntity.delete(npc.nameEntityId);
        npc.nameEntityId = wants ? this.server.allocateEntityId() : null;
        if (npc.nameEntityId !== null) this.byEntity.set(npc.nameEntityId, npc);
      });
    }
  }

  setSkin(npc: NpcEntity, skin: SkinData | undefined): void {
    if (skin && !isSkin(skin)) return;
    npc.definition = { ...npc.definition, skin: skin ? { ...skin } : undefined };
    this.respawn(npc, () => {});
  }

  setEquipment(npc: NpcEntity, equipment: NpcEquipment | undefined): void {
    if (equipment !== undefined && !isEquipment(equipment)) return;
    npc.definition = { ...npc.definition, equipment: equipment ? structuredClone(equipment) : undefined };
    for (const viewer of this.server.getOnlinePlayers()) viewer.send(equipmentPacket(npc, true));
  }

  remove(npc: NpcEntity): void {
    if (this.npcs.get(npc.definition.id) !== npc) return;
    this.hideFromAll(npc);
    this.npcs.delete(npc.definition.id);
    this.byEntity.delete(npc.entityId);
    if (npc.nameEntityId !== null) this.byEntity.delete(npc.nameEntityId);
  }

  // ------------------------------------------------------------ showing

  /** Takes it away from everyone, lets `change` alter it, and shows it again (some changes cannot be made to something that is already there). */
  private respawn(npc: NpcEntity, change: () => void): void {
    this.hideFromAll(npc);
    change();
    for (const viewer of this.server.getOnlinePlayers()) this.showTo(npc, viewer);
  }

  private hideFromAll(npc: NpcEntity): void {
    const ids = npc.nameEntityId === null ? [npc.entityId] : [npc.entityId, npc.nameEntityId];
    for (const viewer of this.server.getOnlinePlayers()) {
      viewer.send(destroyEntities(ids));
      viewer.send(npcListRemove(npc.uuid));
      viewer.send(removeTeam(npc.teamName));
    }
    npc.turned.clear();
  }

  private showTo(npc: NpcEntity, viewer: Player): void {
    const { x, y, z } = npc.definition.position;
    const yaw = npc.definition.yaw ?? 0;
    const pitch = npc.definition.pitch ?? 0;
    const skin = npc.definition.skin;

    viewer.send(npcListAdd(npc.uuid, npc.profileName, skin ? [{ name: "textures", value: skin.value, signature: skin.signature }] : []));
    viewer.send(teamWithHiddenNames(npc.teamName, [npc.profileName]));
    viewer.send(spawnEntity(npc.entityId, npc.uuid, PLAYER_ENTITY_TYPE, x, y, z, yaw, pitch));
    viewer.send(
      entityMetadata(npc.entityId, [
        { index: META.flags, type: "byte", value: npc.definition.glowing ? FLAG_GLOWING : 0 },
        { index: META.playerSkinLayers, type: "byte", value: ALL_SKIN_LAYERS },
      ]),
    );
    viewer.send(headRotation(npc.entityId, yaw));
    if (npc.definition.equipment) viewer.send(equipmentPacket(npc, false));

    if (npc.nameEntityId !== null && npc.definition.name) {
      viewer.send(spawnEntity(npc.nameEntityId, npc.nameStandUuid, ARMOR_STAND_ENTITY_TYPE, x, y + NAME_HEIGHT, z, 0, 0));
      viewer.send(
        entityMetadata(npc.nameEntityId, [
          { index: META.flags, type: "byte", value: FLAG_INVISIBLE },
          { index: META.customName, type: "optionalComponent", value: { text: npc.definition.name } },
          { index: META.nameVisible, type: "boolean", value: true },
          { index: META.armorStandFlags, type: "byte", value: ARMOR_STAND_SMALL_MARKER },
        ]),
      );
    }
  }

  private turnFor(npc: NpcEntity, viewer: Player, yaw: number, pitch: number): void {
    const { x, y, z } = npc.definition.position;
    viewer.send(entityPositionSync(npc.entityId, x, y, z, yaw, pitch));
    viewer.send(headRotation(npc.entityId, yaw));
  }
}

/** What the NPC holds and wears as a packet. With clearOthers, places that have nothing are sent as empty so that old items disappear. */
function equipmentPacket(npc: NpcEntity, clearOthers: boolean): ReturnType<typeof entityEquipment> {
  const entries: Array<{ slot: number; item: { itemId: number; dyedColor?: number } | null }> = [];
  for (const [place, slot] of Object.entries(EQUIPMENT_SLOTS) as Array<[keyof NpcEquipment, number]>) {
    const wanted = npc.definition.equipment?.[place];
    const id = wanted ? itemId(wanted.item) : undefined;
    if (wanted && id !== undefined) entries.push({ slot, item: { itemId: id, dyedColor: wanted.dyedColor } });
    else if (clearOthers) entries.push({ slot, item: null });
  }
  return entityEquipment(npc.entityId, entries);
}

function isEquipment(equipment: NpcEquipment): boolean {
  if (typeof equipment !== "object" || equipment === null) return false;
  return Object.entries(equipment).every(([place, wanted]) => {
    if (!(place in EQUIPMENT_SLOTS)) return false;
    const entry = wanted as { item?: unknown; dyedColor?: unknown };
    if (typeof entry?.item !== "string" || itemId(entry.item) === undefined) return false;
    const color = entry.dyedColor;
    return color === undefined || (typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xffffff);
  });
}

/** The smallest difference between two angles in degrees, in -180..180. */
function angleDifference(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

function isCoordinates(p: { x: number; y: number; z: number }): boolean {
  return [p.x, p.y, p.z].every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE);
}

function isSkin(skin: SkinData): boolean {
  return typeof skin.value === "string" && skin.value.length > 0 && skin.value.length <= 32767 && (skin.signature === undefined || (typeof skin.signature === "string" && skin.signature.length <= 1024));
}

/** Why a definition is not acceptable, or null. Definitions come from plugin data files, so nothing is trusted. */
function validate(definition: NpcDefinition): string | null {
  if (!definition || typeof definition !== "object") return "it is not an object";
  if (typeof definition.id !== "string" || !ID_PATTERN.test(definition.id)) return "the id must be 1-64 letters, digits, _, - or .";
  if (!definition.position || !isCoordinates(definition.position)) return "the position is missing or not numbers";
  for (const angle of [definition.yaw, definition.pitch]) {
    if (angle !== undefined && (typeof angle !== "number" || !Number.isFinite(angle))) return "yaw and pitch must be numbers";
  }
  if (definition.name !== undefined && (typeof definition.name !== "string" || definition.name.length > 256)) return "the name must be text of at most 256 characters";
  if (definition.skin !== undefined && !isSkin(definition.skin)) return "the skin needs a value (and at most a 1024 character signature)";
  if (definition.equipment !== undefined && !isEquipment(definition.equipment)) return "the equipment must name known items in mainHand, offHand, head, chest, legs or feet (dyedColor is a number up to 0xFFFFFF)";
  return null;
}
