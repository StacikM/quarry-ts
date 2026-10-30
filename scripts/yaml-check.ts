import assert from 'node:assert/strict';
import { parseYaml } from '../src/util/yaml';
const parsed:any=parseYaml(`---
npcs:
  sample:
    name: 'O''Brien #1' # comment
    messages:
    - 'hello: world'
    - "escaped\\nline"
    location: {world: lobby, x: -1.5, y: 70, z: 2e2}
    actions:
      - action: message
        value: hello
      - action: console_command
        value: 'say # hi'
    skin: {identifier: "https://example.test/skin#part"}
    text: |-
      line one
      line two
    folded: >
      one
      two
    enabled: true
    missing: null
    empty: []
`);
assert.equal(parsed.npcs.sample.name,"O'Brien #1");
assert.deepEqual(parsed.npcs.sample.messages,['hello: world','escaped\nline']);
assert.deepEqual(parsed.npcs.sample.location,{world:'lobby',x:-1.5,y:70,z:200});
assert.equal(parsed.npcs.sample.actions[1].value,'say # hi');
assert.equal(parsed.npcs.sample.text,'line one\nline two');
assert.equal(parsed.npcs.sample.folded,'one two\n');
assert.equal(parsed.npcs.sample.skin.identifier,'https://example.test/skin#part');
assert.equal(parsed.npcs.sample.enabled,true); assert.equal(parsed.npcs.sample.missing,null);
assert.deepEqual(parseYaml('a: [1, false, {b: "x,y"}]'),{a:[1,false,{b:'x,y'}]});
assert.deepEqual(parseYaml("name: O'Brien # comment"),{name:"O'Brien"});
for(const input of ['a: 1\na: 2','__proto__: polluted','a: &anchor value','a: *anchor','a: !tag value','a: [1, 2','a: "unclosed','a:\n\tbad: value','a: {constructor: nope}']) {
  assert.throws(()=>parseYaml(input),/YAML line \d+:/);
}
assert.throws(()=>parseYaml('a: '+ 'x'.repeat(100),{maxBytes:30}),/size limit/);
assert.throws(()=>parseYaml('a: [[[[[1]]]]]',{maxDepth:3}),/nesting limit/);
assert.throws(()=>parseYaml('a: [1, 2, 3]',{maxNodes:3}),/node limit/);
assert.equal(({} as any).polluted,undefined);
console.log('YAML: Bukkit indentless lists, maps, flow collections, strings, block scalars, errors and resource limits pass.');
