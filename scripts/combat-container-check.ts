import assert from 'node:assert/strict';
import { Inventory, type ItemStack } from '../src/game/Inventory';
import { Containers } from '../src/game/Containers';
import { Combat } from '../src/game/Combat';
import { itemId } from '../src/world/blockStates';
import { EventBus } from '../src/plugins/EventBus';
import type { Player } from '../src/game/Player';
import { containerContent, writeItemStack } from '../src/protocol/inventoryPackets';
import { PacketWriter } from '../src/network/PacketWriter';
import { PacketReader } from '../src/network/PacketReader';
import { REGISTRY_KEYS } from '../src/protocol/registryKeys';
const id = (name: string) => { const value = itemId(name); assert.notEqual(value, undefined); return value!; };
let now = 10000;
const events = new EventBus();
const packets: PacketWriter[] = [];
function player(x = 0): Player {
  const p: any = { x, y: 64, z: 0, yaw: 0, heldSlot: 0, gameMode: 0, awaitingTeleport: null, entityId: x + 1, inventory: new Inventory(), send: (packet: PacketWriter) => packets.push(packet), server: { plugins: { events }, world: { getState: () => 0 }, broadcast: (packet: PacketWriter) => packets.push(packet) } };
  p.setInventorySlot = (slot: number, stack: ItemStack | null) => p.inventory.set(slot, stack);
  p.combat = new Combat(p, () => now); p.containers = new Containers(p); return p;
}
const p = player();
const sword: ItemStack = { itemId: id('diamond_sword'), count: 1, enchantments: { sharpness: 3 }, unbreakable: true };
p.inventory.set(36, sword); sword.enchantments!.sharpness = 99;
assert.equal(p.inventory.get(36)!.enchantments!.sharpness, 3);
assert.equal(p.inventory.set(36, { itemId: id('diamond_sword'), count: 2 }), false);
assert.equal(p.inventory.get(36)!.count, 1);
const click = (slot: number, button = 0, mode = 0, stateId = p.containers.stateId) => p.containers.click({windowId:p.containers.windowId, stateId, slot, button, mode});
p.inventory.set(9, { itemId:id('stone'), count:63 }); p.inventory.set(10, {itemId:id('stone'),count:10});
assert.equal(click(10, 1), true); assert.equal(p.containers.carried!.count,5); assert.equal(p.inventory.get(10)!.count,5);
assert.equal(click(9), true); assert.equal(p.inventory.get(9)!.count,64); assert.equal(p.containers.carried!.count,4);
assert.equal(click(11),true); assert.equal(p.inventory.get(11)!.count,4); assert.equal(p.containers.carried,null);
const stale = p.containers.stateId; click(11); assert.equal(click(12,0,0,stale),false); assert.equal(p.inventory.get(12),null);
click(11); assert.equal(p.containers.carried,null);
assert.equal(click(36,1,2),true); assert.equal(p.inventory.get(37)!.enchantments!.sharpness,3); assert.equal(p.inventory.get(36),null);
assert.equal(click(37,0,1),true); assert.equal(p.inventory.get(9)!.itemId,id('stone')); assert.equal(p.inventory.get(12)!.enchantments!.sharpness,3);
assert.equal(click(12,0,4),false); assert.equal(p.inventory.get(12)!.count,1);
let selected=-1; p.containers.open({title:'Menu',items:new Array(54).fill(null).map((_,i)=>i===0?{itemId:id('diamond'),count:1}:null),onClick:slot=>{selected=slot;}});
click(0); assert.equal(selected,0); assert.equal(p.containers.carried,null); assert.equal(p.inventory.get(12)!.itemId,id('diamond_sword'));
click(0,0,1); assert.equal(p.containers.carried,null); p.containers.close();
p.containers.open({title:'27',items:new Array(27).fill(null)}); assert.equal(p.containers.windowId>0,true); p.containers.close();
const a=player(), b=player(2); a.inventory.set(36,{...sword,enchantments:{sharpness:3}});
assert.equal(a.combat.attack(b),true); assert.equal(b.combat.health,11); assert.equal(a.combat.attack(b),false);
now+=1000;
for (const [slot,name] of [[5,'diamond_helmet'],[6,'diamond_chestplate'],[7,'diamond_leggings'],[8,'diamond_boots']] as const) b.inventory.set(slot,{itemId:id(name),count:1,enchantments:{protection:3}});
b.combat.reset(); assert.equal(a.combat.attack(b),true); assert.ok(b.combat.health>18 && b.combat.health<20);
now+=1000; b.combat.reset();
events.on('test','playerDamage',event=>{event.cancelled=true;}); assert.equal(a.combat.attack(b),false); assert.equal(b.combat.health,20); events.removeAll('test');
events.on('test','playerDeath',event=>{event.cancelled=true;}); b.combat.setHealth(0.1); now+=1000; assert.equal(a.combat.attack(b),false); assert.equal(b.combat.health,0.1); events.removeAll('test');
b.combat.reset(); b.inventory.set(45,{itemId:id('shield'),count:1}); b.yaw=90; a.x=0; b.x=2;
assert.equal(b.combat.useItem(1),true); now+=300; assert.equal(a.combat.attack(b),false); assert.equal(b.combat.health,20);
b.combat.releaseUse(); now+=1000; assert.equal(a.combat.attack(b),true);
a.x=100; now+=1000; assert.equal(a.combat.attack(b),false);
a.x=0; a.server.world.getState=()=>1; assert.equal(a.combat.attack(b),false);
// Wire checks consume each encoded field through to the next slot.
const wire = containerContent(2,7,[{itemId:id('diamond_sword'),count:1,enchantments:{sharpness:3},unbreakable:true},null],null);
const reader = new PacketReader(wire.body()); assert.equal(reader.readVarInt(),0x12); assert.equal(reader.readVarInt(),2); assert.equal(reader.readVarInt(),7); assert.equal(reader.readVarInt(),2);
assert.equal(reader.readVarInt(),1); assert.equal(reader.readVarInt(),id('diamond_sword')); assert.equal(reader.readVarInt(),2); assert.equal(reader.readVarInt(),0); assert.equal(reader.readVarInt(),13); assert.equal(reader.readVarInt(),1); assert.equal(reader.readVarInt(),REGISTRY_KEYS['minecraft:enchantment'].indexOf('minecraft:sharpness')); assert.equal(reader.readVarInt(),3); assert.equal(reader.readVarInt(),4); assert.equal(reader.readVarInt(),0); assert.equal(reader.readVarInt(),0); assert.equal(reader.remaining,0);
console.log('Combat and container state/wire checks passed');
const eater = player(); eater.combat.food=10; eater.inventory.set(36,{itemId:id('cooked_beef'),count:2});
assert.equal(eater.combat.useItem(0),true); now+=1599; eater.combat.tick(); assert.equal(eater.combat.food,10); now++; eater.combat.tick(); assert.equal(eater.combat.food,18); assert.equal(eater.inventory.get(36)!.count,1);
eater.combat.food=10; eater.combat.useItem(0); eater.combat.releaseUse(); now+=2000; eater.combat.tick(); assert.equal(eater.inventory.get(36)!.count,1);
eater.inventory.set(36,{itemId:id('potion'),count:1,potionEffects:[{name:'strength',amplifier:1,durationTicks:1800},{name:'speed',amplifier:1,durationTicks:1800}]});
eater.combat.useItem(0); now+=1600; eater.combat.tick(); assert.equal(eater.combat.effects.get('strength')!.amplifier,1); assert.equal(eater.inventory.get(36)!.itemId,id('glass_bottle'));
eater.inventory.set(36,{itemId:id('golden_apple'),count:3}); eater.combat.setHealth(10); eater.combat.useItem(0); now+=1600; eater.combat.tick(); assert.equal(eater.combat.absorption,4); assert.equal(eater.inventory.get(36)!.count,2); now+=1250; eater.combat.tick(); assert.equal(eater.combat.health,11); now+=120000; eater.combat.tick(); assert.equal(eater.combat.absorption,0); assert.equal(eater.combat.effects.size,0);
// Validate component and new effect/attribute packets with an independent protocol decoder.
const { createDeserializer } = require('minecraft-protocol');
const decoder = createDeserializer({state:'play',isServer:false,version:'1.21.11'});
for (const packet of packets.filter(packet=>[0x12,0x39,0x11,0x66,0x82,0x4c,0x81,0x16,0x29].includes(packet.packetId))) {
  const parsed = decoder.parsePacketBuffer(packet.body()); assert.equal(parsed.metadata.size,packet.body().length);
}
const potionPacket=containerContent(1,1,[{itemId:id('potion'),count:1,potionEffects:[{name:'strength',amplifier:1,durationTicks:1800}]}],null);
const parsedPotion=decoder.parsePacketBuffer(potionPacket.body()); assert.equal(parsedPotion.data.params.items[0].components[0].data.customEffects[0].id,4); assert.equal(parsedPotion.metadata.size,potionPacket.body().length);
console.log('Consumable timing, effects, and independent 1.21.11 decoder checks passed');
for(const [x,y,z]of [[0,0,0],[.4,.9,-.4],[3.9,-2.1,1.2]]){
  const packet=new PacketWriter(0x63).writeVarInt(1).writeVelocity(x,y,z),decoded=decoder.parsePacketBuffer(packet.body());
  assert.equal(decoded.metadata.size,packet.body().length);
  for(const [axis,value]of Object.entries({x,y,z}))assert.ok(Math.abs(decoded.data.params.velocity[axis]-value)<.001);
}
const {Projectiles}=require('../src/game/Projectiles');
const shooter=player(),victim=player();shooter.pitch=0;shooter.moyActivity='duel';shooter.z=0;victim.z=4;
(shooter.server as any).allocateEntityId=()=>999;
(shooter.server as any).getOnlinePlayers=()=>[shooter,victim];
(shooter.server as any).projectiles=new Projectiles(shooter.server);
shooter.inventory.set(36,{itemId:id('bow'),count:1,enchantments:{power:3,infinity:1}});shooter.inventory.set(9,{itemId:id('arrow'),count:1});
assert.equal(shooter.combat.useItem(0),true);now+=1000;shooter.combat.finishUse();assert.equal(shooter.inventory.get(9)!.count,1);
shooter.server.projectiles.tick();shooter.server.projectiles.tick();assert.ok(victim.combat.health<20,'server-simulated arrow hits target');
for(const packet of packets.filter(p=>[0x01,0x23,0x4b,0x61].includes(p.packetId))){const decoded=decoder.parsePacketBuffer(packet.body());assert.equal(decoded.metadata.size,packet.body().length);}
console.log('Scaled velocity vectors, bow/Infinity, simulated arrow hits and combat metadata decode correctly.');
