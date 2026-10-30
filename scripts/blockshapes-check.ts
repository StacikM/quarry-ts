import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { stateOf, STATE_COUNT } from '../src/world/blockStates';
import { isFullCube, hasSturdyTop } from '../src/world/blockShapes';
const data = minecraftData('1.21.11');
const shapes = data.blockCollisionShapes;
let count = 0;
for (const block of data.blocksArray) for (let state=block.minStateId; state<=block.maxStateId; state++) {
  const ids = shapes.blocks[block.name];
  const boxes: number[][] = shapes.shapes[Array.isArray(ids) ? ids[state-block.minStateId] : ids];
  assert.equal(isFullCube(state), boxes.length===1 && boxes[0].every((n,i)=>n===(i<3?0:1)), `${block.name}:${state}`);
  count++;
}
const fixture = (name: string, full: boolean, top: boolean, props = {}) => {
  const state = stateOf(name, props);
  assert.equal(isFullCube(state), full, `${name} full ${JSON.stringify(props)}`);
  assert.equal(hasSturdyTop(state), top, `${name} top ${JSON.stringify(props)}`);
};
fixture('air',false,false); fixture('stone',true,true); fixture('glass',true,true);
fixture('farmland',false,false); fixture('soul_sand',false,true); fixture('honey_block',false,false);
fixture('mud',false,true);
fixture('oak_leaves',true,false); fixture('hopper',false,false);
fixture('snow',false,true,{layers:8}); fixture('snow',false,false,{layers:7});
for (const facing of ['north','south','east','west']) for (const shape of ['straight','inner_left','inner_right','outer_left','outer_right']) {
  fixture('oak_stairs',false,true,{half:'top',facing,shape});
  fixture('oak_stairs',false,false,{half:'bottom',facing,shape});
}
fixture('oak_slab',false,true,{type:'top'}); fixture('oak_slab',false,false,{type:'bottom'});
fixture('oak_slab',true,true,{type:'double'});
for (const state of [-1,STATE_COUNT,NaN,0.5]) { assert.equal(isFullCube(state),false); assert.equal(hasSturdyTop(state),false); }
assert.equal(count, STATE_COUNT);
console.log(`Block shapes: ${count} collision states match source; sturdy-top fixtures passed.`);
