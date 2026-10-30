/** Independent decoder and source registry checks for every Java 1.21.11 state. */
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { STATE_COUNT, stateOf, defaultState, describeState, withProps, itemId, itemName, stateForItem } from '../src/world/blockStates';
const data = minecraftData('1.21.11');
const PrismarineBlock = require('prismarine-block')('1.21.11');
let count = 0;
for (const block of data.blocksArray) {
  assert.equal(defaultState(block.name), block.defaultState);
  assert.equal(stateOf(`minecraft:${block.name}`), block.defaultState);
  for (let id = block.minStateId; id <= block.maxStateId; id++) {
    const decoded = describeState(id);
    assert.equal(decoded.name, block.name);
    const independent = PrismarineBlock.fromStateId(id, 0).getProperties();
    assert.deepEqual(decoded.properties, Object.fromEntries(Object.entries(independent).map(([k, v]) => [k, String(v)])));
    assert.equal(stateOf(decoded.name, decoded.properties), id);
    assert.equal(withProps(id, {}), id);
    count++;
  }
}
assert.equal(count, STATE_COUNT);
assert.equal(stateOf('air'), 0);
assert.equal(stateOf('stone'), 1);
assert.equal(withProps(stateOf('oak_log'), { axis: 'x' }), data.blocksByName.oak_log.minStateId);
const leaf = stateOf('oak_leaves', { persistent: true, distance: 2 });
assert.equal(describeState(leaf).properties.waterlogged, 'false', 'unspecified properties preserve defaults');
assert.equal(describeState(withProps(leaf, { distance: 1 })).properties.persistent, 'true');
for (const id of [-1, STATE_COUNT, 0.5, NaN, Infinity]) assert.throws(() => describeState(id), RangeError);
assert.throws(() => stateOf('missing_block'), RangeError);
assert.throws(() => stateOf('other:stone'), RangeError);
assert.throws(() => stateOf('stone', { bogus: 0 }), RangeError);
assert.throws(() => stateOf('oak_log', { axis: 'w' }), RangeError);
assert.throws(() => stateOf('oak_leaves', { distance: 8 }), RangeError);
assert.throws(() => stateOf('oak_leaves', { persistent: 1 }), RangeError);
assert.throws(() => withProps(-1, {}), RangeError);
for (const item of data.itemsArray) {
  assert.equal(itemName(item.id), item.name);
  assert.equal(itemId(item.name), item.id);
  assert.equal(itemId(`minecraft:${item.name}`), item.id);
  const state = stateForItem(item.id);
  if (state !== undefined) assert(state >= 0 && state < STATE_COUNT);
}
for (const [item, block] of [['stone','stone'], ['redstone','redstone_wire'], ['wheat_seeds','wheat'], ['carrot','carrots'], ['string','tripwire']]) {
  assert.equal(stateForItem(itemId(item)!), stateOf(block));
}
for (const item of ['air', 'wheat', 'diamond_sword', 'stick', 'water_bucket']) assert.equal(stateForItem(itemId(item)!), undefined);
assert.equal(itemName(-1), undefined);
assert.equal(itemId('other:stone'), undefined);
assert.equal(stateForItem(-1), undefined);
const mutable = describeState(leaf);
mutable.properties.persistent = 'false';
assert.equal(describeState(leaf).properties.persistent, 'true', 'descriptions cannot mutate the registry');
console.log(`Block states: ${count} states independently decoded and round-tripped; ${data.itemsArray.length} item mappings checked.`);
