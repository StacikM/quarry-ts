import { BLOCK_DATA, ITEM_DATA, STATE_COUNT, type BlockRow } from './blockStateData';
export { STATE_COUNT };
type Props = Record<string, string | number | boolean>;

// One entry per block type, rather than a property object for every state/cell.
const byName = new Map(BLOCK_DATA.map(row => [row[0], row]));
const itemsByName = new Map(ITEM_DATA.map(row => [row[1], row]));
const itemsById = new Map(ITEM_DATA.map(row => [row[0], row]));
const unqualified = (name: string): string => name.startsWith('minecraft:') ? name.slice(10) : name;

function blockNamed(name: string): BlockRow {
  const row = byName.get(unqualified(name));
  if (!row) throw new RangeError(`Unknown block: ${name}`);
  return row;
}

function blockAt(id: number): BlockRow {
  if (!Number.isInteger(id) || id < 0 || id >= STATE_COUNT) throw new RangeError(`Invalid block state: ${id}`);
  let low = 0, high = BLOCK_DATA.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1, row = BLOCK_DATA[mid];
    if (id < row[1]) high = mid - 1;
    else if (id > row[2]) low = mid + 1;
    else return row;
  }
  throw new RangeError(`Unknown block state: ${id}`);
}

function propertiesOf(row: BlockRow, id: number): Record<string, string> {
  const properties: Record<string, string> = {};
  let offset = id - row[1];
  for (let i = row[4].length - 1; i >= 0; i--) {
    const [name, values] = row[4][i];
    properties[name] = values[offset % values.length];
    offset = Math.floor(offset / values.length);
  }
  return properties;
}

function changed(row: BlockRow, id: number, props: Props): number {
  const values = propertiesOf(row, id);
  for (const [name, value] of Object.entries(props)) {
    const property = row[4].find(p => p[0] === name);
    if (!property) throw new RangeError(`Unknown property ${row[0]}.${name}`);
    if (!['string', 'number', 'boolean'].includes(typeof value) || !property[1].includes(String(value))) {
      throw new RangeError(`Invalid value for ${row[0]}.${name}: ${String(value)}`);
    }
    values[name] = String(value);
  }
  let offset = 0;
  for (const [name, choices] of row[4]) offset = offset * choices.length + choices.indexOf(values[name]);
  return row[1] + offset;
}

export function stateOf(name: string, props: Props = {}): number {
  const row = blockNamed(name);
  return changed(row, row[3], props);
}
export function defaultState(name: string): number { return blockNamed(name)[3]; }
export function describeState(id: number): { name: string; properties: Record<string, string> } {
  const row = blockAt(id);
  return { name: row[0], properties: propertiesOf(row, id) };
}
export function withProps(id: number, props: Props): number { return changed(blockAt(id), id, props); }
export function itemName(id: number): string | undefined { return itemsById.get(id)?.[1]; }
export function itemId(name: string): number | undefined { return itemsByName.get(unqualified(name))?.[0]; }
export function stateForItem(id: number): number | undefined {
  const state = itemsById.get(id)?.[2];
  return state === undefined || state < 0 ? undefined : state;
}
