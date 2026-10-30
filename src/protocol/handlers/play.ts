import type { Connection } from "../../network/Connection";
import type { PacketReader } from "../../network/PacketReader";
import type { Player } from "../../game/Player";
import { PlayIn } from "../packetIds";
import { animation, blockChange, entityHeadLook, entityTeleport } from "../clientbound";
import { runCommand } from "../../game/commands";
import {
  DOOR_ITEM_TO_BLOCK,
  canOpenByHand,
  isDoorBlock,
  placeDoor,
  planDoor,
  removeOtherDoorHalf,
  toggleDoor,
} from "../../game/doors";
import { breakUnsupported, canSurvive, placementMetadata, upperHalfMetadata } from "../../game/support";
import { GameMode } from "../../game/GameMode";
import { FACE_OFFSETS, type BlockPosition } from "../../world/BlockPosition";
import { Block, MAX_BLOCK_ID } from "../../world/blocks";

/** Falling below this teleports you back to spawn. */
const VOID_Y = -20;

/** Handles every packet a logged-in player sends us. */
export function handlePlay(conn: Connection, packetId: number, reader: PacketReader): void {
  const player = conn.player;
  if (!player) return;

  switch (packetId) {
    case PlayIn.KeepAlive: {
      const id = reader.readVarInt();
      if (id === player.pendingKeepAliveId) {
        player.lastKeepAliveReply = Date.now();
        player.pendingKeepAliveId = null;
      }
      break;
    }

    case PlayIn.ChatMessage: {
      const message = sanitizeChat(reader.readString());
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
          const line = event.format.replace(/\{(player|message)\}/g, (_, key: string) =>
            key === "player" ? player.username : event.message,
          );
          player.server.broadcastMessage(line);
        }
      }
      break;
    }

    // The client sends one of these four movement packets every tick
    // (20 times a second), depending on what changed.
    case PlayIn.Player:
      player.onGround = reader.readBoolean();
      break;

    case PlayIn.PlayerPosition: {
      const from = { x: player.x, y: player.y, z: player.z };
      player.x = reader.readDouble();
      player.y = reader.readDouble(); // feet height
      player.z = reader.readDouble();
      player.onGround = reader.readBoolean();
      onPlayerMoved(player, from);
      break;
    }

    case PlayIn.PlayerLook:
      player.yaw = reader.readFloat();
      player.pitch = reader.readFloat();
      player.onGround = reader.readBoolean();
      onPlayerMoved(player);
      break;

    case PlayIn.PlayerPositionAndLook: {
      const from = { x: player.x, y: player.y, z: player.z };
      player.x = reader.readDouble();
      player.y = reader.readDouble();
      player.z = reader.readDouble();
      player.yaw = reader.readFloat();
      player.pitch = reader.readFloat();
      player.onGround = reader.readBoolean();
      onPlayerMoved(player, from);
      break;
    }

    case PlayIn.PlayerDigging:
      handleDigging(player, reader);
      break;

    case PlayIn.BlockPlacement:
      handleBlockPlacement(player, reader);
      break;

    case PlayIn.Animation:
      // The client swung its arm; show that to everyone else.
      player.server.broadcast(animation(player.entityId, 0), player);
      break;

    // Everything else (inventory clicks, settings, plugin channels...)
    // is ignored. That's fine, the client doesn't need an answer.
  }
}

/** The vanilla client refuses to send more than this, so anything longer is a modified client. */
const MAX_CHAT_LENGTH = 100;

/**
 * Chat comes straight from the network. Remove the "section sign" (which
 * starts a colour code, so a hacked client could fake [OP] prefixes) and
 * control characters, then cut to the vanilla length limit.
 */
function sanitizeChat(raw: string): string {
  return raw.replace(/[\u00a7\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_CHAT_LENGTH);
}

/** `from` is only given when the packet contained a position (not for look-only packets). */
function onPlayerMoved(player: Player, from?: { x: number; y: number; z: number }): void {
  if (player.y < VOID_Y) {
    const spawn = player.server.getSpawnPoint();
    player.teleport(spawn.x, spawn.y, spawn.z);
    return;
  }

  // Teleport is the simplest "entity moved" packet. Vanilla uses smaller
  // "relative move" packets to save bandwidth, but this is easier to follow.
  player.server.broadcast(entityTeleport(player), player);
  player.server.broadcast(entityHeadLook(player), player);
  player.updateLoadedChunks();
  if (from) {
    player.server.plugins.events.emit("playerMove", { player, from });
  }
}

/**
 * Status values: 0 = started digging, 1 = cancelled, 2 = finished,
 * 3/4 = drop item, 5 = finish using item (eating, bow).
 * In creative, blocks break instantly, so the client only sends 0.
 */
function handleDigging(player: Player, reader: PacketReader): void {
  const status = reader.readVarInt(); // a VarInt in protocol 47 (a plain byte for values 0-5, so real clients look the same)
  const pos = reader.readPosition();
  reader.readByte(); // which face was hit

  const brokeBlock = status === 2 || (status === 0 && player.gameMode === GameMode.Creative);
  if (!brokeBlock || !isInWorld(pos)) return;

  const world = player.server.world;
  const blockId = world.getBlockId(pos);
  const metadata = world.getBlockMetadata(pos);
  const event = player.server.plugins.events.emit("blockBreak", { player, position: pos, blockId, cancelled: false });
  if (event.cancelled) {
    // The client already removed the block on its screen; put it back.
    player.send(blockChange(pos, blockId, metadata));
    return;
  }

  player.server.setBlock(pos, Block.Air);
  if (isDoorBlock(blockId)) {
    removeOtherDoorHalf(player.server, pos, blockId, metadata); // a door is two blocks: take both
  }
  breakUnsupported(player.server, pos); // plants, torches... that stood on it break too
}

function handleBlockPlacement(player: Player, reader: PacketReader): void {
  const clicked = reader.readPosition();
  const face = reader.readByte();
  const item = reader.readSlot();
  // (cursor position fields follow, we don't need them)

  // Face -1 (255) means "used the item in the air", like eating. Not a placement.
  const offset = FACE_OFFSETS[face];
  if (!offset) return;
  if (player.gameMode === GameMode.Spectator) return;

  const world = player.server.world;

  // Right-clicking a door opens or closes it (also in adventure mode), instead of placing anything.
  if (isInWorld(clicked) && isDoorBlock(world.getBlockId(clicked))) {
    if (canOpenByHand(world.getBlockId(clicked))) {
      toggleDoor(player.server, clicked);
    } else {
      player.send(blockChange(clicked, world.getBlockId(clicked), world.getBlockMetadata(clicked)));
    }
    return;
  }

  if (player.gameMode === GameMode.Adventure) return;

  const target: BlockPosition = { x: clicked.x + offset.x, y: clicked.y + offset.y, z: clicked.z + offset.z };

  // Doors are items (id above 255) that place a two-block-tall block.
  const doorBlock = DOOR_ITEM_TO_BLOCK[item.itemId];
  if (doorBlock !== undefined) {
    placeDoorFromItem(player, clicked, face, target, doorBlock);
    return;
  }

  const isBlock = item.itemId > 0 && item.itemId <= MAX_BLOCK_ID;

  if (!isBlock || !isInWorld(target) || world.getBlockId(target) !== Block.Air) {
    // The client may have already drawn the block (it predicts placements).
    // Tell it what's really there so it doesn't show a ghost block.
    if (isInWorld(target)) {
      player.send(blockChange(target, world.getBlockId(target), world.getBlockMetadata(target)));
    }
    return;
  }

  // The metadata is the wool colour or wood type the item says; torches and ladders get the side they are put on.
  const metadata = placementMetadata(item.itemId, face, item.damage);
  if (metadata === null || !canSurvive(world, target, item.itemId, metadata)) {
    // Not where it could stay (a flower on stone, a torch on a ceiling): the client drew it anyway, so take it away.
    player.send(blockChange(target, world.getBlockId(target), world.getBlockMetadata(target)));
    return;
  }
  const event = player.server.plugins.events.emit("blockPlace", {
    player,
    position: target,
    blockId: item.itemId,
    metadata,
    cancelled: false,
  });
  if (event.cancelled) {
    player.send(blockChange(target, Block.Air, 0)); // remove the block the client drew
    return;
  }

  player.server.setBlock(target, item.itemId, metadata);
  const upperMeta = upperHalfMetadata(item.itemId, metadata); // tall flowers: two blocks
  const upperPos = { x: target.x, y: target.y + 1, z: target.z };
  if (upperMeta !== null && isInWorld(upperPos) && world.getBlockId(upperPos) === Block.Air) player.server.setBlock(upperPos, item.itemId, upperMeta);
}

/** Doors can only be placed on top of a block (face 1), and need room for both halves. */
function placeDoorFromItem(player: Player, clicked: BlockPosition, face: number, target: BlockPosition, doorBlock: number): void {
  const world = player.server.world;
  const up = { x: target.x, y: target.y + 1, z: target.z };

  // Tell the client what is really there, undoing any door it drew while predicting.
  const resync = (): void => {
    for (const pos of [target, up]) {
      if (isInWorld(pos)) player.send(blockChange(pos, world.getBlockId(pos), world.getBlockMetadata(pos)));
    }
  };

  // Placing onto tall grass puts the door where the grass was, not above it.
  const clickedId = world.getBlockId(clicked);
  const base = clickedId === 31 || clickedId === 32 ? clicked : target;

  const plan = face === 1 ? planDoor(world, base, doorBlock, player.yaw) : null;
  if (!plan) {
    resync();
    return;
  }

  const event = player.server.plugins.events.emit("blockPlace", {
    player,
    position: plan.position,
    blockId: doorBlock,
    metadata: plan.lowerMeta,
    cancelled: false,
  });
  if (event.cancelled) {
    resync();
    return;
  }

  placeDoor(player.server, plan);
}

function isInWorld(pos: BlockPosition): boolean {
  return pos.y >= 0 && pos.y <= 255;
}
