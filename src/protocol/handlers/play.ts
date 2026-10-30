import type { Connection } from "../../network/Connection";
import type { PacketReader } from "../../network/PacketReader";
import type { Player } from "../../game/Player";
import { PlayIn } from "../packetIds";
import { animation, blockChange, blockChangedAck, entityHeadLook, entityTeleport } from "../clientbound";
import { runCommand } from "../../game/commands";
import { canOpenByHand, doorFor, isDoorBlock, placeDoor, planDoor, removeOtherDoorHalf, toggleDoor } from "../../game/doors";
import { isReplaceable, placementState } from "../../game/placement";
import { GameMode } from "../../game/GameMode";
import { FACE_OFFSETS, type BlockPosition } from "../../world/BlockPosition";
import { Block } from "../../world/blocks";
import { describeState, itemName, stateForItem } from "../../world/blockStates";

/** Falling below this teleports you back to spawn. */
const VOID_Y = -20;
/** Positions further out than this are nonsense (the world border is 29,999,984). */
const MAX_COORDINATE = 30_000_000;

/** Handles every packet a logged-in player sends us. */
export function handlePlay(conn: Connection, packetId: number, reader: PacketReader): void {
  const player = conn.player;
  if (!player) return;

  switch (packetId) {
    case PlayIn.KeepAlive: {
      const id = Number(reader.readLong());
      if (id === player.pendingKeepAliveId) {
        player.lastKeepAliveReply = Date.now();
        player.pendingKeepAliveId = null;
      }
      break;
    }

    case PlayIn.TeleportConfirm:
      if (reader.readVarInt() === player.awaitingTeleport) player.awaitingTeleport = null;
      break;

    case PlayIn.ChatMessage:
      // (a timestamp, a salt and a signature follow; an offline-mode server does not check them)
      handleChat(player, reader.readString());
      break;

    case PlayIn.ChatCommand:
    case PlayIn.ChatCommandSigned:
      runCommand(player, sanitizeChat(reader.readString()));
      break;

    // The client sends one of these four movement packets every tick
    // (20 times a second), depending on what changed. The last field of each is
    // a set of flags; bit 0 is "standing on the ground".
    case PlayIn.PlayerStatusOnly:
      player.onGround = (reader.readUnsignedByte() & 1) !== 0;
      break;

    case PlayIn.PlayerPosition: {
      const x = reader.readDouble();
      const y = reader.readDouble();
      const z = reader.readDouble();
      const flags = reader.readUnsignedByte();
      moveTo(player, x, y, z, player.yaw, player.pitch, flags);
      break;
    }

    case PlayIn.PlayerLook: {
      const yaw = reader.readFloat();
      const pitch = reader.readFloat();
      const flags = reader.readUnsignedByte();
      moveTo(player, player.x, player.y, player.z, yaw, pitch, flags);
      break;
    }

    case PlayIn.PlayerPositionAndLook: {
      const x = reader.readDouble();
      const y = reader.readDouble();
      const z = reader.readDouble();
      const yaw = reader.readFloat();
      const pitch = reader.readFloat();
      const flags = reader.readUnsignedByte();
      moveTo(player, x, y, z, yaw, pitch, flags);
      break;
    }

    case PlayIn.PlayerAbilities:
      // Bit 1 says the player is flying. Only players who may fly can be.
      player.flying = (reader.readUnsignedByte() & 2) !== 0 && (player.gameMode === GameMode.Creative || player.gameMode === GameMode.Spectator);
      break;

    case PlayIn.PlayerAction:
      handleDigging(player, reader);
      break;

    case PlayIn.UseItemOn:
      handleBlockPlacement(player, reader);
      break;

    case PlayIn.HeldItemChange: {
      const slot = reader.readShort();
      if (slot >= 0 && slot <= 8) player.heldSlot = slot;
      break;
    }

    case PlayIn.SetCreativeSlot: {
      const slot = reader.readShort();
      // Slots 36-44 are the hotbar. Only creative players may create items.
      if (player.gameMode === GameMode.Creative && slot >= 36 && slot <= 44) {
        player.hotbar[slot - 36] = reader.readSlot().itemId;
      }
      break;
    }

    case PlayIn.Swing:
      // The client swung an arm (0 = main hand, 1 = off hand); show that to everyone else.
      player.server.broadcast(animation(player.entityId, reader.readVarInt() === 0 ? 0 : 3), player);
      break;

    // Everything else (inventory clicks, settings, plugin channels...)
    // is ignored. That's fine, the client doesn't need an answer.
  }
}

/** The vanilla client refuses to send more than this, so anything longer is a modified client. */
const MAX_CHAT_LENGTH = 256;

/**
 * Chat comes straight from the network. Remove the "section sign" (which
 * starts a colour code, so a hacked client could fake [OP] prefixes) and
 * control characters, then cut to the vanilla length limit.
 */
function sanitizeChat(raw: string): string {
  return raw.replace(/[§\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_CHAT_LENGTH);
}

function handleChat(player: Player, raw: string): void {
  const message = sanitizeChat(raw);
  if (message.startsWith("/")) {
    runCommand(player, message.slice(1));
  } else if (message.length > 0) {
    // Plugins may cancel the message or rewrite it (e.g. a chat filter).
    const event = player.server.plugins.events.emit("playerChat", {
      player,
      message,
      format: "<{player}> {message}",
      cancelled: false,
    });
    if (!event.cancelled) {
      // One pass over the template, so a message that contains "{player}" stays as typed.
      const line = event.format.replace(/\{(player|message)\}/g, (_, key: string) => (key === "player" ? player.username : event.message));
      player.server.broadcastMessage(line);
    }
  }
}

function isUsable(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) < MAX_COORDINATE;
}

/** The client says where it is. Ignored while it has not yet confirmed our last forced move, and when the numbers are nonsense. */
function moveTo(player: Player, x: number, y: number, z: number, yaw: number, pitch: number, flags: number): void {
  if (!isUsable(x) || !isUsable(y) || !isUsable(z) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  if (player.awaitingTeleport !== null) return;

  const from = { x: player.x, y: player.y, z: player.z };
  player.x = x;
  player.y = y;
  player.z = z;
  player.yaw = yaw;
  player.pitch = Math.max(-90, Math.min(90, pitch));
  player.onGround = (flags & 1) !== 0;
  onPlayerMoved(player, from);
}

function onPlayerMoved(player: Player, from: { x: number; y: number; z: number }): void {
  if (player.y < VOID_Y) {
    const spawn = player.server.getSpawnPoint();
    player.teleport(spawn.x, spawn.y, spawn.z);
    return;
  }

  // Keep the other players' picture of this player up to date. Vanilla uses smaller
  // "relative move" packets to save bandwidth, but one absolute packet is easier to follow.
  player.server.broadcast(entityTeleport(player), player);
  player.server.broadcast(entityHeadLook(player), player);
  player.updateLoadedChunks();
  player.server.plugins.events.emit("playerMove", { player, from });
}

/**
 * Status values: 0 = started digging, 1 = cancelled, 2 = finished,
 * 3/4 = drop item, 5 = finish using item, 6 = swap hands.
 * In creative, blocks break instantly, so the client only sends 0.
 * Every action carries a sequence number that we must answer, otherwise the
 * client keeps showing its own guess about the block.
 */
function handleDigging(player: Player, reader: PacketReader): void {
  const status = reader.readVarInt();
  const pos = reader.readPosition();
  reader.readByte(); // which face was hit
  const sequence = reader.readVarInt();

  try {
    const brokeBlock = status === 2 || (status === 0 && player.gameMode === GameMode.Creative);
    if (!brokeBlock || !isInWorld(pos)) return;

    const world = player.server.world;
    const state = world.getState(pos);
    const event = player.server.plugins.events.emit("blockBreak", { player, position: pos, state, cancelled: false });
    if (event.cancelled || player.gameMode === GameMode.Spectator || player.gameMode === GameMode.Adventure) {
      // The client already removed the block on its screen; put it back.
      player.send(blockChange(pos, state));
      return;
    }

    player.server.setBlock(pos, Block.Air);
    if (isDoorBlock(state)) {
      removeOtherDoorHalf(player.server, pos, state); // a door is two blocks: take both
    }
  } finally {
    player.send(blockChangedAck(sequence));
  }
}

/** The item in the hand the player used: the selected hotbar slot for the main hand. We know nothing about the off hand. */
function itemInHand(player: Player, hand: number): number {
  return hand === 0 ? player.hotbar[player.heldSlot] : -1;
}

function handleBlockPlacement(player: Player, reader: PacketReader): void {
  const hand = reader.readVarInt();
  const clicked = reader.readPosition();
  const face = reader.readVarInt();
  const cursor = { x: reader.readFloat(), y: reader.readFloat(), z: reader.readFloat() };
  reader.readBoolean(); // whether the click was inside the block
  reader.readBoolean(); // whether it touched the world border
  const sequence = reader.readVarInt();

  try {
    placeBlock(player, hand, clicked, face, cursor);
  } finally {
    player.send(blockChangedAck(sequence));
  }
}

function placeBlock(player: Player, hand: number, clicked: BlockPosition, face: number, cursor: { x: number; y: number; z: number }): void {
  const offset = FACE_OFFSETS[face];
  if (!offset || !isInWorld(clicked)) return;
  if (player.gameMode === GameMode.Spectator) return;

  const world = player.server.world;
  const clickedState = world.getState(clicked);

  // Right-clicking a door opens or closes it (also in adventure mode), instead of placing anything.
  if (isDoorBlock(clickedState)) {
    if (canOpenByHand(clickedState)) {
      toggleDoor(player.server, clicked);
    } else {
      player.send(blockChange(clicked, clickedState));
    }
    return;
  }

  if (player.gameMode === GameMode.Adventure) return;

  // Placing onto tall grass and similar puts the block where the grass was, not next to it.
  const target: BlockPosition = isReplaceable(clickedState)
    ? clicked
    : { x: clicked.x + offset.x, y: clicked.y + offset.y, z: clicked.z + offset.z };

  const itemId = itemInHand(player, hand);
  const resync = (): void => {
    for (const pos of [target, { x: target.x, y: target.y + 1, z: target.z }]) {
      if (isInWorld(pos)) player.send(blockChange(pos, world.getState(pos)));
    }
  };

  // Doors are items that place a two-block-tall block.
  const doorName = doorFor(itemName(itemId));
  if (doorName !== undefined) {
    const plan = face === 1 || isReplaceable(clickedState) ? planDoor(world, target, doorName, player.yaw, cursor) : null;
    if (!plan) return resync();
    const event = player.server.plugins.events.emit("blockPlace", { player, position: plan.position, state: plan.lower, cancelled: false });
    if (event.cancelled) return resync();
    placeDoor(player.server, plan);
    return;
  }

  const base = stateForItem(itemId);
  if (base === undefined || !isInWorld(target) || !isReplaceable(world.getState(target))) {
    // The client may have already drawn the block (it predicts placements).
    // Tell it what's really there so it doesn't show a ghost block.
    return resync();
  }

  const state = placementState(base, face, cursor, player.yaw);
  if (state === null) return resync();

  const event = player.server.plugins.events.emit("blockPlace", { player, position: target, state, cancelled: false });
  if (event.cancelled) return resync();

  player.server.setBlock(target, state);
}

function isInWorld(pos: BlockPosition): boolean {
  return pos.y >= 0 && pos.y <= 255;
}
