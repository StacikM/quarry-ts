/** Modern state coverage, baseline source values, and state-dependent fixtures. */
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { stateOf, STATE_COUNT } from '../src/world/blockStates';
import { lightOpacity, lightEmission, OPACITY_TABLE, EMISSION_TABLE } from '../src/world/lightData';
const data = minecraftData('1.21.11');
const PrismarineBlock = require('prismarine-block')('1.21.11');
assert.equal(OPACITY_TABLE.length, STATE_COUNT);
assert.equal(EMISSION_TABLE.length, STATE_COUNT);
let checked = 0;
for (const block of data.blocksArray) for (let id = block.minStateId; id <= block.maxStateId; id++) {
  assert(Number.isInteger(lightOpacity(id)) && lightOpacity(id) >= 0 && lightOpacity(id) <= 255);
  assert(Number.isInteger(lightEmission(id)) && lightEmission(id) >= 0 && lightEmission(id) <= 15);
  const props = PrismarineBlock.fromStateId(id, 0).getProperties();
  let expectedOpacity = block.filterLight === 15 ? 255 : block.filterLight;
  if (block.name === 'water' || props.waterlogged === true) expectedOpacity = Math.max(expectedOpacity, 3);
  if (props.type === 'double' && block.name.endsWith('_slab')) expectedOpacity = 255;
  assert.equal(lightOpacity(id), expectedOpacity, `${block.name} state ${id}`);
  const changingEmitter = block.states.some(p => ['lit','berries','bloom','charges','sculk_sensor_phase'].includes(p.name))
    || block.name === 'light' || block.name === 'sea_pickle';
  if (!changingEmitter) {
    assert.equal(lightEmission(id), block.emitLight, block.name);
  }
  checked++;
}
const opacity = (name: string, value: number, props = {}) => assert.equal(lightOpacity(stateOf(name, props)), value, `${name} opacity`);
const emission = (name: string, value: number, props = {}) => assert.equal(lightEmission(stateOf(name, props)), value, `${name} emission`);
opacity('air',0); opacity('stone',255); opacity('water',3);
opacity('oak_leaves',1,{persistent:true});
opacity('oak_slab',255,{type:'double'}); opacity('oak_slab',0,{type:'bottom'});
opacity('oak_slab',3,{type:'bottom',waterlogged:true});
for (const [name, level] of [['lava',15],['torch',14],['sea_lantern',15],['soul_torch',10]] as const) emission(name,level);
for (const [name, level] of [['furnace',13],['redstone_lamp',15],['redstone_ore',9],['campfire',15],['redstone_torch',7]] as const) {
  emission(name,0,{lit:false}); emission(name,level,{lit:true});
}
for (let level=0; level<=15; level++) emission('light',level,{level});
for (let candles=1; candles<=4; candles++) {
  emission('candle',candles*3,{candles,lit:true}); emission('candle',0,{candles,lit:false});
  emission('sea_pickle',candles*3+3,{pickles:candles,waterlogged:true}); emission('sea_pickle',0,{pickles:candles,waterlogged:false});
}
for (const [charges,level] of [0,3,7,11,15].entries()) emission('respawn_anchor',level,{charges});
emission('cave_vines',14,{berries:true}); emission('cave_vines',0,{berries:false});
emission('copper_bulb',15,{lit:true}); emission('oxidized_copper_bulb',4,{lit:true}); emission('copper_bulb',0,{lit:false});
emission('sculk_sensor',0,{sculk_sensor_phase:'inactive'}); emission('sculk_sensor',1,{sculk_sensor_phase:'active'});
emission('sculk_catalyst',0,{bloom:false}); emission('sculk_catalyst',6,{bloom:true});
for (const state of [-1,STATE_COUNT,NaN,0.5]) { assert.equal(lightOpacity(state),255); assert.equal(lightEmission(state),0); }
assert.equal(checked,STATE_COUNT);
console.log(`Modern light registry: ${checked} states covered; baseline and state fixtures passed (water compatibility attenuation=3).`);
