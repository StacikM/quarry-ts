import { describeState, stateOf } from "../../../world/blockStates";
import { EditError } from "./common";

/**
 * Turns what a player types into blocks:
 *   a block      stone, oak_stairs[facing=north,half=top]  ("minecraft:" is optional)
 *   a pattern    50%stone,30%dirt,gravel   (blocks picked at random; a weight is optional)
 *   a mask       stone,dirt,oak_log[axis=y]   (what //replace and //count look for)
 */

interface BlockSpec {
  name: string;
  props: Record<string, string>;
}

const BLOCK_SPEC = /^([a-z0-9_]+)(?:\[([a-z0-9_=,]*)\])?$/;

/** Splits on commas that are not inside [brackets], because a block's properties are separated by commas too. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseBlockSpec(text: string): BlockSpec {
  const match = BLOCK_SPEC.exec(text.trim().toLowerCase().replace(/^minecraft:/, ""));
  if (!match) throw new EditError(`"${text}" is not a block. Examples: stone, oak_stairs[facing=north]`);
  const props: Record<string, string> = {};
  for (const pair of match[2] ? match[2].split(",") : []) {
    const [key, value, ...extra] = pair.split("=");
    if (!key || value === undefined || value === "" || extra.length > 0) throw new EditError(`"${pair}" in "${text}" should look like name=value`);
    props[key] = value;
  }
  // Ask the block tables right away, so a typo is reported before anything is changed.
  stateFor({ name: match[1], props });
  return { name: match[1], props };
}

function stateFor(spec: BlockSpec): number {
  try {
    return stateOf(spec.name, spec.props);
  } catch (err) {
    if (err instanceof RangeError) throw new EditError(err.message);
    throw err;
  }
}

/**
 * A pattern is a function that gives the state to place at the next block.
 * `held` says what "hand" means (the block the player holds), and `random` can be replaced in tests.
 */
export function parsePattern(text: string, held: () => number | undefined, random: () => number = Math.random): () => number {
  const entries = splitList(text).map((entry) => {
    const weighted = /^(\d+(?:\.\d+)?)%(.+)$/.exec(entry);
    const weight = weighted ? Number(weighted[1]) : 1;
    const name = weighted ? weighted[2] : entry;
    if (!(weight > 0)) throw new EditError(`The weight in "${entry}" must be more than 0`);
    if (name.toLowerCase() === "hand") {
      const state = held();
      if (state === undefined) throw new EditError("Hold a block in your hand to use \"hand\".");
      return { weight, state };
    }
    return { weight, state: stateFor(parseBlockSpec(name)) };
  });
  if (entries.length === 0) throw new EditError("Say which block to use, for example: stone");
  if (entries.length === 1) return () => entries[0].state;

  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return () => {
    let roll = random() * total;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll < 0) return entry.state;
    }
    return entries[entries.length - 1].state;
  };
}

/** A mask says yes or no for a block state. A block without [properties] matches every state of that block. */
export function parseMask(text: string): (state: number) => boolean {
  const specs = splitList(text).map(parseBlockSpec);
  if (specs.length === 0) throw new EditError("Say which block to look for, for example: stone,dirt");
  const known = new Map<number, boolean>();
  return (state) => {
    let answer = known.get(state);
    if (answer === undefined) {
      const described = describeState(state);
      answer = specs.some((spec) => spec.name === described.name && Object.entries(spec.props).every(([key, value]) => described.properties[key] === value));
      known.set(state, answer);
    }
    return answer;
  };
}
