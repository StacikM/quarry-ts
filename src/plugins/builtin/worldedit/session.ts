import type { MinecraftServer } from "../../../game/Server";
import { EditError, MAX_BLOCKS, MAX_Y, MIN_Y, type Pos, type Region } from "./common";

/** What one player has in hand while editing: the two selected corners, what they copied, and what they can undo. */
export interface Session {
  pos1?: Pos;
  pos2?: Pos;
  clipboard?: Clipboard;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

/** A copied box. `offset` is where its corner was, relative to where the player stood when copying. */
export interface Clipboard {
  size: Pos;
  offset: Pos;
  /** Block states, x changing fastest, then z, then y. */
  states: Uint16Array;
}

/** One edit, stored compactly: the positions it changed and what was there before and after. */
export interface HistoryEntry {
  positions: Int32Array;
  before: Uint16Array;
  after: Uint16Array;
}

/** How many changed blocks a player's undo list keeps in total. The oldest edits are forgotten first. */
const HISTORY_BLOCKS = 2 * MAX_BLOCKS;

const sessions = new Map<string, Session>();

export function sessionFor(username: string): Session {
  const key = username.toLowerCase();
  let session = sessions.get(key);
  if (!session) {
    session = { undo: [], redo: [] };
    sessions.set(key, session);
  }
  return session;
}

export function forgetSession(username: string): void {
  sessions.delete(username.toLowerCase());
}

/** The box between the two selected corners, if both are set. WorldGuard uses it too. */
export function selectionOf(username: string): Region | undefined {
  const session = sessions.get(username.toLowerCase());
  if (!session?.pos1 || !session.pos2) return undefined;
  return regionBetween(session.pos1, session.pos2);
}

export function regionBetween(a: Pos, b: Pos): Region {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

/**
 * The blocks an edit wants to place. Setting the same position twice keeps the last state, so
 * an edit never has to think about order. Blocks are kept per chunk column, which costs
 * 128 KB per column but nothing per block.
 */
export class ChangeSet {
  private readonly columns = new Map<string, { x: number; z: number; cells: Uint16Array }>();
  /** How many different positions are in the set. */
  size = 0;

  set(x: number, y: number, z: number, state: number): void {
    if (y < MIN_Y || y > MAX_Y) return;
    const key = `${x >> 4},${z >> 4}`;
    let column = this.columns.get(key);
    if (!column) {
      column = { x: x >> 4, z: z >> 4, cells: new Uint16Array(16 * 16 * 256) };
      this.columns.set(key, column);
    }
    const index = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (column.cells[index] === 0) {
      if (++this.size > MAX_BLOCKS) throw new EditError(`That is too many blocks. The limit is ${MAX_BLOCKS} per edit.`);
    }
    column.cells[index] = state + 1; // 0 means "nothing planned here"
  }

  forEach(visit: (x: number, y: number, z: number, state: number) => void): void {
    for (const column of this.columns.values()) {
      for (let index = 0; index < column.cells.length; index++) {
        const planned = column.cells[index];
        if (planned !== 0) visit((column.x << 4) | (index & 15), index >> 8, (column.z << 4) | ((index >> 4) & 15), planned - 1);
      }
    }
  }
}

/** Places the blocks and remembers how to take them back. Returns how many blocks really changed. */
export function applyChanges(server: MinecraftServer, session: Session, changes: ChangeSet): number {
  const positions: number[] = [];
  const before: number[] = [];
  const after: number[] = [];
  changes.forEach((x, y, z, state) => {
    const old = server.world.getState({ x, y, z });
    if (old === state) return;
    positions.push(x, y, z);
    before.push(old);
    after.push(state);
  });
  const entry: HistoryEntry = { positions: Int32Array.from(positions), before: Uint16Array.from(before), after: Uint16Array.from(after) };
  if (entry.before.length === 0) return 0;

  paint(server, entry, "after");
  session.undo.push(entry);
  session.redo.length = 0;
  let kept = session.undo.reduce((sum, e) => sum + e.before.length, 0);
  while (kept > HISTORY_BLOCKS && session.undo.length > 1) kept -= session.undo.shift()!.before.length;
  return entry.before.length;
}

/** Writes one side of a history entry into the world. */
function paint(server: MinecraftServer, entry: HistoryEntry, side: "before" | "after"): void {
  const states = entry[side];
  const list: { x: number; y: number; z: number; state: number }[] = new Array(states.length);
  for (let i = 0; i < states.length; i++) {
    list[i] = { x: entry.positions[i * 3], y: entry.positions[i * 3 + 1], z: entry.positions[i * 3 + 2], state: states[i] };
  }
  server.setBlocks(list);
}

/** Takes back the last `times` edits. Returns how many edits and blocks were undone. */
export function undo(server: MinecraftServer, session: Session, times: number): { edits: number; blocks: number } {
  let edits = 0;
  let blocks = 0;
  while (edits < times && session.undo.length > 0) {
    const entry = session.undo.pop()!;
    paint(server, entry, "before");
    session.redo.push(entry);
    edits++;
    blocks += entry.before.length;
  }
  return { edits, blocks };
}

export function redo(server: MinecraftServer, session: Session, times: number): { edits: number; blocks: number } {
  let edits = 0;
  let blocks = 0;
  while (edits < times && session.redo.length > 0) {
    const entry = session.redo.pop()!;
    paint(server, entry, "after");
    session.undo.push(entry);
    edits++;
    blocks += entry.before.length;
  }
  return { edits, blocks };
}
