// Development-only registry generation. Runtime imports only the generated TypeScript.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const data = require('minecraft-data')('1.21.11');
assert.equal(data.version.version, 774);
const blocks = data.blocksArray.slice().sort((a, b) => a.minStateId - b.minStateId);
let next = 0;
const rows = blocks.map(block => {
  assert.equal(block.minStateId, next, `gap before ${block.name}`);
  const properties = block.states.map(p => {
    const values = p.values ?? (p.type === 'bool' ? ['true', 'false'] : Array.from({ length: p.num_values }, (_, i) => String(i)));
    assert.equal(values.length, p.num_values);
    return [p.name, values.map(String)];
  });
  assert.equal(properties.reduce((n, [, values]) => n * values.length, 1), block.maxStateId - block.minStateId + 1);
  assert(block.defaultState >= block.minStateId && block.defaultState <= block.maxStateId);
  next = block.maxStateId + 1;
  return [block.name, block.minStateId, block.maxStateId, block.defaultState, properties];
});
assert(next <= 65536, 'Chunk storage requires states to fit Uint16');
// Items whose placed block has a different registry name. Placement orientation,
// support, waterlogging and multi-block behavior are handled by the game layer.
const aliases = {
  wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots',
  melon_seeds: 'melon_stem', pumpkin_seeds: 'pumpkin_stem', cocoa_beans: 'cocoa',
  sweet_berries: 'sweet_berry_bush', glow_berries: 'cave_vines',
  torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop',
  redstone: 'redstone_wire', string: 'tripwire',
};
const items = data.itemsArray.map(item => {
  const block = data.blocksByName[aliases[item.name] ?? item.name];
  // Wheat is harvested food, not the seed item; air is a sentinel, not a block item.
  const state = block && !['air', 'wheat'].includes(item.name) ? block.defaultState : -1;
  return [item.id, item.name, state];
});
const output = `/** Generated from minecraft-data 3.109.0, Java 1.21.11 (protocol 774).
 * Regenerate: node scripts/generate-block-states.cjs. No runtime data dependency.
 * Property order is the protocol mixed-radix order; booleans are true then false.
 */
export type BlockRow = readonly [name: string, min: number, max: number, defaultId: number, properties: readonly (readonly [string, readonly string[]])[]];
export const STATE_COUNT = ${next};
/** Synchronized biome registry ids for terrain, from the same version. */
export const BIOME_IDS: Readonly<Record<string, number>> = ${JSON.stringify(Object.fromEntries(data.biomesArray.map(b => [b.name, b.id])))};
export const BLOCK_DATA: readonly BlockRow[] = [
${rows.map(row => '  ' + JSON.stringify(row) + ',').join('\n')}
];
/** [registry id, item name, default placed state (-1 if not placeable)]. */
export const ITEM_DATA: readonly (readonly [number, string, number])[] = [
${items.map(row => '  ' + JSON.stringify(row) + ',').join('\n')}
];
`;
fs.writeFileSync(path.join(__dirname, '../src/world/blockStateData.ts'), output);
console.log(`Generated ${next} states, ${rows.length} blocks, ${items.length} items for 1.21.11.`);
