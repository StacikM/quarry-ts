import { randomUUID } from "node:crypto";
import type { MinecraftServer } from "./Server";
import type { Player } from "./Player";
import { GameMode } from "./GameMode";
import { breakUnsupported } from "./support";
import type { BlockPosition } from "../world/BlockPosition";
import { Block } from "../world/blocks";
import { describeState, stateOf } from "../world/blockStates";
import { blastResistance } from "../world/blastResistance";
import { hasSturdyTop, isFullCube } from "../world/blockShapes";
import {
  entityMetadata, explosion, spawnEntity, entityPositionSync, destroyEntities, TNT_BLOCK_STATE_FIELD, TNT_ENTITY_TYPE, TNT_FUSE_FIELD,
} from "../protocol/clientbound";

/** Ticks between lighting TNT and the explosion (4 seconds), like in the vanilla game. */
const FUSE_TICKS = 80;
/** The power of a TNT explosion. Stone (6) stops a ray after a few blocks; obsidian (1200) stops it at once. */
export const TNT_POWER = 4;
/** Primed TNT is pulled down by this much speed every tick, and jumps up a little when lit. */
const GRAVITY = 0.04;
const LIGHTING_HOP = 0.2;
/** Explosions throw players this far (in power multiples), and do nothing beyond it. */
const KNOCKBACK_REACH = 2;

const TNT_STATES = new Set([stateOf("tnt", { unstable: false }), stateOf("tnt", { unstable: true })]);
const TNT_ITEM_STATE = stateOf("tnt");
/** The items that light TNT when used on it. */
const LIGHTERS = new Set(["flint_and_steel", "fire_charge"]);

export const isTnt = (state: number): boolean => TNT_STATES.has(state);
export const isLighter = (item: string | undefined): boolean => item !== undefined && LIGHTERS.has(item);

const resistanceOfState = new Map<number, number>();
function resistance(state: number): number {
  let known = resistanceOfState.get(state);
  if (known === undefined) {
    known = blastResistance(describeState(state).name);
    resistanceOfState.set(state, known);
  }
  return known;
}

interface PrimedTnt {
  entityId: number;
  x: number;
  y: number;
  z: number;
  velocityY: number;
  /** False while it rests on something. */
  falling: boolean;
  fuse: number;
}

/**
 * TNT and explosions. Lit TNT is a block that turns into an entity, which falls, flashes and explodes after
 * four seconds. An explosion shoots 1352 rays out from its centre; each ray eats blocks until its strength is
 * used up (hard blocks use it up faster). Every block a ray went through with strength left is destroyed.
 * Nothing is dropped, there are no health points on this server so nobody is hurt, and players are thrown back.
 */
export class Explosions {
  /** Where the randomness comes from; tests replace it. */
  random: () => number = Math.random;
  private readonly primed = new Map<number, PrimedTnt>();

  constructor(private readonly server: MinecraftServer) {}

  /** The TNT that is lit right now. */
  get litCount(): number {
    return this.primed.size;
  }

  /** Where the lit TNT is, and how many ticks it has left. */
  lit(): { x: number; y: number; z: number; fuse: number }[] {
    return [...this.primed.values()].map((tnt) => ({ x: tnt.x, y: tnt.y, z: tnt.z, fuse: tnt.fuse }));
  }

  /** Turns the TNT block at `pos` into lit TNT. Returns false if there is no TNT there. */
  ignite(pos: BlockPosition, fuse = FUSE_TICKS): boolean {
    if (!isTnt(this.server.world.getState(pos))) return false;
    this.server.setBlock(pos, Block.Air);
    this.light(pos, fuse);
    return true;
  }

  /**
   * A player uses flint and steel on a TNT block. It counts as breaking the block, so plugins that protect
   * blocks (the lobby, WorldGuard) can refuse it, and players who cannot break blocks cannot light it.
   */
  igniteByPlayer(player: Player, pos: BlockPosition): boolean {
    if (player.gameMode === GameMode.Adventure || player.gameMode === GameMode.Spectator) return false;
    const state = this.server.world.getState(pos);
    if (!isTnt(state)) return false;
    const event = this.server.plugins.events.emit("blockBreak", { player, position: pos, state, cancelled: false });
    return !event.cancelled && this.ignite(pos);
  }

  /** Makes lit TNT appear (and jump) at the block position, for everybody. */
  private light(pos: BlockPosition, fuse: number): void {
    const tnt: PrimedTnt = { entityId: this.server.allocateEntityId(), x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5, velocityY: LIGHTING_HOP, falling: true, fuse };
    this.primed.set(tnt.entityId, tnt);
    this.server.broadcast(spawnEntity(tnt.entityId, randomUUID(), TNT_ENTITY_TYPE, tnt.x, tnt.y, tnt.z, 0, 0));
    this.server.broadcast(this.dataOf(tnt));
  }

  private dataOf(tnt: PrimedTnt): ReturnType<typeof entityMetadata> {
    return entityMetadata(tnt.entityId, [
      { index: TNT_FUSE_FIELD, type: "int", value: tnt.fuse },
      { index: TNT_BLOCK_STATE_FIELD, type: "blockState", value: TNT_ITEM_STATE },
    ]);
  }

  /** A player who has just joined sees the TNT that is already lit, with the time it has left. */
  showAllTo(player: Player): void {
    for (const tnt of this.primed.values()) {
      player.send(spawnEntity(tnt.entityId, randomUUID(), TNT_ENTITY_TYPE, tnt.x, tnt.y, tnt.z, 0, 0));
      player.send(this.dataOf(tnt));
    }
  }

  tick(): void {
    const world = this.server.world;
    for (const tnt of [...this.primed.values()]) {
      const column = { x: Math.floor(tnt.x), z: Math.floor(tnt.z) };
      if (!tnt.falling && !this.solidBelow(column.x, tnt.y, column.z)) tnt.falling = true; // what it stood on is gone
      if (tnt.falling) {
        tnt.velocityY -= GRAVITY;
        tnt.y += tnt.velocityY;
        const blockY = Math.floor(tnt.y);
        if (blockY < 0 || tnt.y < -64) {
          this.remove(tnt); // fell out of the world
          continue;
        }
        if (isFullCube(world.getState({ x: column.x, y: blockY, z: column.z })) && tnt.velocityY < 0) {
          tnt.y = blockY + 1;
          tnt.velocityY = 0;
          tnt.falling = false;
        } else {
          tnt.velocityY *= 0.98;
        }
        this.server.broadcast(entityPositionSync(tnt.entityId, tnt.x, tnt.y, tnt.z, 0, 0));
      }
      if (--tnt.fuse <= 0) {
        this.remove(tnt);
        this.explode(tnt.x, tnt.y + 0.0625, tnt.z, TNT_POWER);
      }
    }
  }

  private solidBelow(x: number, y: number, z: number): boolean {
    const state = this.server.world.getState({ x, y: Math.floor(y - 0.001), z });
    return isFullCube(state) || hasSturdyTop(state);
  }

  private remove(tnt: PrimedTnt): void {
    this.primed.delete(tnt.entityId);
    this.server.broadcast(destroyEntities([tnt.entityId]));
  }

  /**
   * Blows up the world around (x, y, z): destroys blocks, lights the TNT it reaches, and throws players back.
   * Plugins hear the "explosion" event first and can cancel it or take blocks out of its list.
   * Returns how many blocks were destroyed, or null if a plugin cancelled it.
   */
  explode(x: number, y: number, z: number, power: number): number | null {
    const blocks = this.findBlocks(x, y, z, power);
    const event = this.server.plugins.events.emit("explosion", { position: { x, y, z }, power, blocks, cancelled: false });
    if (event.cancelled) return null;

    const world = this.server.world;
    const knockbacks = this.knockbackOfPlayers(x, y, z, power); // before the blocks go: walls shield
    const lit = event.blocks.filter((pos) => isTnt(world.getState(pos)));

    this.server.setBlocks(event.blocks.map((pos) => ({ x: pos.x, y: pos.y, z: pos.z, state: Block.Air })));
    for (const pos of event.blocks.slice(0, 2000)) breakUnsupported(this.server, pos); // plants and torches that stood on them
    for (const pos of lit) this.light(pos, 10 + Math.floor(this.random() * 20)); // a chain reaction, with a short fuse

    for (const player of this.server.getOnlinePlayers()) {
      player.send(explosion(x, y, z, power, event.blocks.length, knockbacks.get(player) ?? null));
    }
    return event.blocks.length;
  }

  /** The blocks the explosion destroys: the ones its rays pass through while they still have strength. */
  private findBlocks(x: number, y: number, z: number, power: number): BlockPosition[] {
    const world = this.server.world;
    const found = new Map<string, BlockPosition>();
    const edge = 15;
    for (let i = 0; i <= edge; i++) {
      for (let j = 0; j <= edge; j++) {
        for (let k = 0; k <= edge; k++) {
          if (i !== 0 && i !== edge && j !== 0 && j !== edge && k !== 0 && k !== edge) continue; // only the rays towards the surface of the cube
          let dx = (i / edge) * 2 - 1;
          let dy = (j / edge) * 2 - 1;
          let dz = (k / edge) * 2 - 1;
          const length = Math.hypot(dx, dy, dz);
          dx = (dx / length) * 0.3;
          dy = (dy / length) * 0.3;
          dz = (dz / length) * 0.3;

          let strength = power * (0.7 + this.random() * 0.6);
          let px = x;
          let py = y;
          let pz = z;
          for (; strength > 0; strength -= 0.225) {
            const pos = { x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz) };
            if (pos.y < 0 || pos.y > 255) break;
            const state = world.getState(pos);
            if (state !== Block.Air) {
              strength -= (resistance(state) + 0.3) * 0.3;
              if (strength > 0) found.set(`${pos.x},${pos.y},${pos.z}`, pos);
            }
            px += dx;
            py += dy;
            pz += dz;
          }
        }
      }
    }
    return [...found.values()];
  }

  /**
   * How hard each player is thrown. The closer, and the less a wall is in the way, the harder.
   * Players who cannot be pushed (spectators, flying creative players) are left alone.
   */
  private knockbackOfPlayers(x: number, y: number, z: number, power: number): Map<Player, { x: number; y: number; z: number }> {
    const result = new Map<Player, { x: number; y: number; z: number }>();
    const reach = power * KNOCKBACK_REACH;
    for (const player of this.server.getOnlinePlayers()) {
      if (player.gameMode === GameMode.Spectator || (player.gameMode === GameMode.Creative && player.flying)) continue;
      const eye = { x: player.x - x, y: player.y + 1.62 - y, z: player.z - z };
      const distance = Math.hypot(eye.x, eye.y, eye.z);
      if (distance >= reach || distance === 0) continue;
      const impact = (1 - distance / reach) * this.exposure({ x, y, z }, player);
      if (impact <= 0) continue;
      result.set(player, { x: (eye.x / distance) * impact, y: (eye.y / distance) * impact, z: (eye.z / distance) * impact });
    }
    return result;
  }

  /** How much of a player the blast can reach, from 0 (behind a wall) to 1: three points of the body are tried. */
  private exposure(from: { x: number; y: number; z: number }, player: Player): number {
    let clear = 0;
    for (const height of [0.1, 0.9, 1.62]) if (this.clearLine(from, { x: player.x, y: player.y + height, z: player.z })) clear++;
    return clear / 3;
  }

  private clearLine(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const steps = Math.ceil(length / 0.5);
    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      const pos = { x: Math.floor(from.x + (to.x - from.x) * t), y: Math.floor(from.y + (to.y - from.y) * t), z: Math.floor(from.z + (to.z - from.z) * t) };
      if (isFullCube(this.server.world.getState(pos))) return false;
    }
    return true;
  }
}
