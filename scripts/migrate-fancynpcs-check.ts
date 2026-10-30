import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateFancyNpcs, miniMessage } from '../src/migrate/fancynpcs';
import { validNpcDocument } from '../src/plugins/builtin/npcData';
// Synthetic fixtures follow NpcManagerImpl save/load in v2.2.0 and v2.4.4.
const legacy=`npcs:
  legacy-guide:
    name: Guide
    displayName: '<gold><bold>Guide</bold></gold>'
    type: PLAYER
    spawnEntity: true
    location:
      ==: org.bukkit.Location
      world: lobby
      x: 12.5
      y: 72.0
      z: -8.5
      yaw: 90
      pitch: 0
    skin:
      identifier: ExampleSkin
      value: dGV4dHVyZQ==
      signature: c2lnbmF0dXJl
    messages:
    - 'Welcome %player_name%!'
    playerCommands:
    - 'rules'
    serverCommands: []
    turnToPlayer: true
    interactionCooldown: 1.5
    scale: 1.0
    showInTab: false
    customFutureField: keep-me
  villager:
    type: VILLAGER
`;
const newer=`npcs:
  games:
    name: Games
    displayName: '<gradient:#ff0000:#0000ff>Games</gradient>'
    location: {world: lobby, x: 0.5, y: 73, z: 0.5}
    skin: {identifier: ExampleSkin, variant: SLIM}
    spawnEntity: true
    actions:
      RIGHT_CLICK:
        '3': {action: send_to_server, value: survival}
        '1': {action: message, value: 'Hi {player}'}
        '2': {action: wait, value: '2'}
      LEFT_CLICK:
        '1': {action: player_command_as_op, value: 'give {player} diamond'}
      CUSTOM:
        '1': {action: message, value: hidden}
  guarded:
    location: {x: 1, y: 70, z: 1}
    actions:
      ANY_CLICK:
        1: {action: need_permission, value: admin}
        2: {action: console_command, value: 'stop'}
`;
const old=migrateFancyNpcs(legacy), modern=migrateFancyNpcs(newer);
assert.equal(old.report.migrated,1); assert.equal(old.report.skipped.length,1);
const a=old.data.npcs[0];
assert.equal(a.cooldownMs,1500); assert.equal(a.skin!.value,'dGV4dHVyZQ==');
assert.equal(a.skin!.signature,'c2lnbmF0dXJl'); assert.equal(a.leftovers!.customFutureField,'keep-me');
assert.deepEqual(a.actions.map(a=>a.type),['player_command','message']);
assert.equal(a.actions[1].value,'Welcome {player}!'); assert(a.name!.startsWith('§6§l'));
assert.equal(modern.data.npcs[0].skin,undefined); assert.equal(modern.data.npcs[0].skinName,'ExampleSkin');
assert.deepEqual(modern.data.npcs[0].actions.map(a=>[a.type,a.delayTicks??0]),[['message',0],['server',40]]);
assert(modern.report.unsupported.some(s=>s.includes('player_command_as_op')));
assert(modern.report.unsupported.some(s=>s.includes('CUSTOM')));
assert.equal(modern.data.npcs[1].actions.length,0,'unsupported permission guard must not expose later privileged actions');
assert(validNpcDocument(old.data)); assert(validNpcDocument(modern.data));
assert(miniMessage('<gradient:#ff0000:#00ff00>x</gradient>').startsWith('§x§f§f§0§0§0§0'));
assert.equal(miniMessage('<red>a<reset>b'),'§ca§rb');
assert.equal(migrateFancyNpcs('npcs: {bad: {location: {x: 1, y: -64, z: 1}}}').report.skipped.length,1);
assert.throws(()=>migrateFancyNpcs('other: 1'),/top-level npcs/);
const root=process.cwd(), temp=fs.mkdtempSync(path.join(root,'.migrate-check-'));
try {
  fs.writeFileSync(path.join(temp,'npcs.yml'),legacy);
  const command=[path.join(root,'node_modules/tsx/dist/cli.mjs'),path.join(root,'scripts/migrate-fancynpcs.ts'),path.join(temp,'npcs.yml'),'--out',path.join(temp,'converted.json')];
  const result=spawnSync(process.execPath,command,{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert(result.stdout.includes('Migrated 1; skipped 1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,'converted.json'),'utf8')),old.data);
  assert.equal(spawnSync(process.execPath,command,{encoding:'utf8'}).status,1,'CLI must not overwrite an existing migration');
} finally { if(path.dirname(temp)!==root||!path.basename(temp).startsWith('.migrate-check-')) throw Error('Unsafe cleanup'); fs.rmSync(temp,{recursive:true,force:true}); }
console.log('FancyNpcs migration: v2.2/v2.4.4 fixtures, ordered delays, skins, unsupported actions, leftovers and CLI pass.');
