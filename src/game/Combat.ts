import type { Player } from './Player';
import { itemId, itemName } from '../world/blockStates';
import { sameItem, cloneStack } from './Inventory';
import { EFFECT_IDS, healthPacket } from '../protocol/inventoryPackets';
import { PacketWriter } from '../network/PacketWriter';
import { isFullCube } from '../world/blockShapes';
import type { ItemStack } from './Inventory';

export interface CombatEffect { amplifier: number; expiresAt: number }
export interface DamageEvent { player: Player; attacker?: Player; damage: number; cause: string; cancelled: boolean }
export interface DeathEvent { player: Player; killer?: Player; cancelled: boolean }
export function enchantment(stack: ItemStack | null, name: string): number { return stack?.enchantments?.[name] ?? stack?.enchantments?.[`minecraft:${name}`] ?? 0; }
/** Authoritative melee state. Times are milliseconds from an injectable clock. */
export class Combat {
  health = 20;
  food = 20;
  saturation = 5;
  absorption = 0;
  readonly effects = new Map<string, CombatEffect>();
  private consuming: { slot: number; stack: ItemStack; completesAt: number } | null = null;
  private nextRegeneration = Infinity;
  private lastAttack = -Infinity;
  private lastDamage = -Infinity;
  private previousDamage = 0;
  private blockingSince = Infinity;
  private blockingSlot = -1;
  private shieldDisabledUntil = 0;
  private drawing: { slot:number; started:number; stack:ItemStack } | null = null;
  private naturalHealAt=0;
  constructor(private readonly player: Player, private readonly now: () => number = Date.now) {}
  sync(): void {
    this.player.send(healthPacket(this.health, this.food, this.saturation));
    this.player.send(new PacketWriter(0x61).writeVarInt(this.player.entityId).writeUnsignedByte(17).writeVarInt(3).writeFloat(this.absorption).writeUnsignedByte(255));
  }
  setHealth(value: number): void { if (!Number.isFinite(value)) throw new Error('Invalid health'); this.health = Math.max(0, Math.min(20, value)); this.sync(); }
  reset(): void { this.health = 20; this.food = 20; this.saturation = 5; this.absorption = 0; for (const name of this.effects.keys()) if (EFFECT_IDS[name] !== undefined) this.player.send(new PacketWriter(0x4c).writeVarInt(this.player.entityId).writeVarInt(EFFECT_IDS[name])); this.effects.clear(); this.syncSpeed(); this.lastDamage = -Infinity; this.lastAttack = -Infinity; this.releaseUse(); this.sync(); }
  useItem(hand: number): boolean {
    const slot = hand === 1 ? 45 : 36 + this.player.heldSlot;
    if (hand !== 0 && hand !== 1) return false;
    const stack = this.player.inventory.get(slot), name = itemName(stack?.itemId ?? -1);
    if (stack && name === 'bow') {
      if (this.drawing?.slot === slot) return true;
      if (!Array.from({length:46},(_,i)=>this.player.inventory.get(i)).some(s=>itemName(s?.itemId??-1)==='arrow')) return false;
      this.releaseUse(); this.drawing={slot,started:this.now(),stack:cloneStack(stack)!};this.syncUse(hand);return true;
    }
    if (stack && (name === 'cooked_beef' || name === 'golden_apple' || (name === 'potion' && stack.potionEffects?.length))) {
      if (name === 'cooked_beef' && this.food >= 20) return false;
      if (this.consuming?.slot === slot) return true;
      this.releaseUse(); this.consuming = { slot, stack: cloneStack(stack)!, completesAt: this.now() + 1600 }; this.syncUse(hand);return true;
    }
    if (name !== 'shield' || this.now() < this.shieldDisabledUntil) return false;
    this.releaseUse();
    this.blockingSlot = slot; this.blockingSince = this.now();this.syncUse(hand);return true;
  }
  private syncUse(hand?:number):void {
    this.player.server.broadcast(new PacketWriter(0x61).writeVarInt(this.player.entityId).writeUnsignedByte(8).writeVarInt(0).writeByte(hand===undefined?0:1|(hand===1?2:0)).writeUnsignedByte(255));
  }
  releaseUse(): void { const active=!!this.drawing||!!this.consuming||this.blockingSlot>=0;this.drawing = null; this.consuming = null; this.blockingSlot = -1; this.blockingSince = Infinity;if(active)this.syncUse(); }
  finishUse(): void {
    const draw=this.drawing;this.releaseUse();if(!draw||this.player.moyActivity!=='duel'||draw.slot!==36+this.player.heldSlot||!sameItem(draw.stack,this.player.inventory.get(draw.slot)))return;
    const seconds=Math.min(1,(this.now()-draw.started)/1000),charge=(seconds*seconds+seconds*2)/3;
    if(charge<.1)return;
    let arrowSlot=-1;for(let i=0;i<46;i++)if(itemName(this.player.inventory.get(i)?.itemId??-1)==='arrow'){arrowSlot=i;break;}
    if(arrowSlot<0)return;
    if(!enchantment(draw.stack,'infinity')&&this.player.gameMode!==1){const s=this.player.inventory.get(arrowSlot)!;this.player.setInventorySlot(arrowSlot,s.count>1?{...s,count:s.count-1}:null);}
    this.player.server.projectiles.shoot(this.player,charge,enchantment(draw.stack,'power'));
  }
  addEffect(name: string, amplifier: number, durationTicks: number): void {
    const id = EFFECT_IDS[name];
    if (id === undefined || !Number.isInteger(amplifier) || amplifier < 0 || amplifier > 255 || !Number.isInteger(durationTicks) || durationTicks < 1) throw new Error('Unsupported effect');
    const current = this.effects.get(name);
    if (current && current.expiresAt > this.now() && (current.amplifier > amplifier || current.amplifier === amplifier && current.expiresAt >= this.now() + durationTicks * 50)) return;
    this.effects.set(name, { amplifier, expiresAt: this.now() + durationTicks * 50 });
    this.player.send(new PacketWriter(0x82).writeVarInt(this.player.entityId).writeVarInt(id).writeVarInt(amplifier).writeVarInt(durationTicks).writeUnsignedByte(6));
    if (name === 'speed') this.syncSpeed();
    if (name === 'absorption') this.absorption = 4 * (amplifier + 1);
    if (name === 'regeneration') this.nextRegeneration = this.now() + 2500 / 2 ** amplifier;
  }
  tick(): void {
    if(this.player.moyActivity==='duel'&&this.health>0&&this.health<20&&this.food>=18&&this.now()>=this.naturalHealAt){
      const fast=this.food===20&&this.saturation>0,heal=fast?Math.min(1,this.saturation/6):1;
      this.health=Math.min(20,this.health+heal);if(fast)this.saturation=Math.max(0,this.saturation-heal);else this.food=Math.max(0,this.food-1);
      this.naturalHealAt=this.now()+(fast?500:4000);this.sync();
    }
    for (const [name, effect] of this.effects) if (effect.expiresAt <= this.now()) {
      this.effects.delete(name);
      if (name === 'absorption') this.absorption = 0;
      this.player.send(new PacketWriter(0x4c).writeVarInt(this.player.entityId).writeVarInt(EFFECT_IDS[name]));
      if (name === 'speed') this.syncSpeed();
    }
    const regeneration = this.effects.get('regeneration');
    if (regeneration && this.health > 0 && this.health < 20 && this.now() >= this.nextRegeneration) {
      this.setHealth(this.health + 1); this.nextRegeneration = this.now() + Math.max(50, 2500 / 2 ** regeneration.amplifier);
    }
    const use = this.consuming;
    if (!use) return;
    const current = this.player.inventory.get(use.slot);
    if (this.health <= 0 || (use.slot !== 45 && use.slot !== 36 + this.player.heldSlot) || !sameItem(current, use.stack) || current?.count !== use.stack.count) { this.releaseUse(); return; }
    if (this.now() < use.completesAt) return;
    this.consuming = null;
    this.syncUse();
    const name = itemName(use.stack.itemId);
    if (name === 'cooked_beef') { this.food = Math.min(20, this.food + 8); this.saturation = Math.min(this.food, this.saturation + 12.8); }
    if (name === 'golden_apple') { this.food = Math.min(20, this.food + 4); this.saturation = Math.min(this.food, this.saturation + 9.6); this.addEffect('regeneration', 1, 100); this.addEffect('absorption', 0, 2400); }
    for (const effect of use.stack.potionEffects ?? []) this.addEffect(effect.name, effect.amplifier, effect.durationTicks);
    if (this.player.gameMode !== 1) {
      if (name === 'potion') this.player.setInventorySlot(use.slot, this.player.moyActivity==='duel'?null:{ itemId: glassBottleId(), count: 1 });
      else this.player.setInventorySlot(use.slot, use.stack.count > 1 ? { ...use.stack, count: use.stack.count - 1 } : null);
    }
    this.sync();
  }
  private syncSpeed(): void {
    const level = this.effectLevel('speed');
    const packet = new PacketWriter(0x81).writeVarInt(this.player.entityId).writeVarInt(1).writeVarInt(20).writeDouble(0.1).writeVarInt(level ? 1 : 0);
    if (level) packet.writeString('minecraft:effect.speed').writeDouble(0.2 * level).writeByte(2);
    this.player.send(packet);
  }
  attack(target: Player): boolean {
    const p = this.player;
    if (p === target || this.health <= 0 || target.combat.health <= 0 || p.gameMode === 3 || p.awaitingTeleport !== null || target.awaitingTeleport !== null) return false;
    // Eye to target bounding box, maximum survival reach of three blocks.
    const dx = Math.max(0, Math.abs(p.x - target.x) - 0.3), dz = Math.max(0, Math.abs(p.z - target.z) - 0.3);
    const eye = p.y + 1.62, dy = Math.max(target.y - eye, eye - (target.y + 1.8), 0);
    if (![dx, dy, dz].every(Number.isFinite) || dx * dx + dy * dy + dz * dz > 9) return false;
    // Reject occlusion by solid cubes; partial block shape ray tracing remains unsupported.
    const distance = Math.hypot(target.x - p.x, target.y + 1 - eye, target.z - p.z);
    for (let t = 0.1; t < distance; t += 0.1) {
      const f = t / distance;
      if (isFullCube(p.server.world.getState({ x: Math.floor(p.x + (target.x - p.x) * f), y: Math.floor(eye + (target.y + 1 - eye) * f), z: Math.floor(p.z + (target.z - p.z) * f) }))) return false;
    }
    const weapon = p.inventory.get(36 + p.heldSlot), name = itemName(weapon?.itemId ?? -1) ?? '';
    const stats = weaponStats(name);
    const charge = Math.max(0, Math.min(1, (this.now() - this.lastAttack + 25) / (1000 / stats.speed)));
    this.lastAttack = this.now(); this.releaseUse();
    const sharp = enchantment(weapon, 'sharpness');
    const strength = this.effectLevel('strength'), weakness = this.effectLevel('weakness');
    let damage = Math.max(0, stats.damage + 3 * strength - 4 * weakness) * (0.2 + charge * charge * 0.8) + (sharp ? 0.5 * sharp + 0.5 : 0) * charge;
    // Criticals require more movement state than Quarry currently validates; no guessed critical bonus.
    const hit=target.combat.damage(damage, p, 'melee', name.endsWith('_axe') && charge > 0.9);
    if(hit&&charge>.2){const length=Math.hypot(target.x-p.x,target.z-p.z)||1;target.setVelocity?.((target.x-p.x)/length*.4,.4,(target.z-p.z)/length*.4);}
    return hit;
  }
  damage(amount: number, attacker?: Player, cause = 'generic', disableShield = false): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || this.health <= 0 || this.player.gameMode === 1 || this.player.gameMode === 3) return false;
    if (attacker && this.blocks(attacker)) {
      if (disableShield) { this.shieldDisabledUntil = this.now() + 5000; this.releaseUse(); this.player.send(new PacketWriter(0x16).writeString('minecraft:shield').writeVarInt(100)); }
      return false;
    }
    const armor = this.armor();
    let damage = amount * (1 - Math.min(20, Math.max(armor.points / 5, armor.points - amount / (2 + armor.toughness / 4))) / 25);
    damage *= 1 - Math.min(20, armor.protection) * 0.04;
    damage *= Math.max(0, 1 - this.effectLevel('resistance') * 0.2);
    if (this.now() - this.lastDamage < 500) { if (damage <= this.previousDamage) return false; damage -= this.previousDamage; }
    const event: DamageEvent = { player: this.player, attacker, damage, cause, cancelled: false };
    this.player.server.plugins.events.emit('playerDamage', event);
    if (event.cancelled || !Number.isFinite(event.damage) || event.damage <= 0) return false;
    if (this.health - Math.max(0, event.damage - this.absorption) <= 0) {
      const death: DeathEvent = { player: this.player, killer: attacker, cancelled: false };
      this.player.server.plugins.events.emit('playerDeath', death);
      if (death.cancelled) return false;
    }
    this.previousDamage = damage + (this.now() - this.lastDamage < 500 ? this.previousDamage : 0); this.lastDamage = this.now();
    const absorbed = Math.min(this.absorption, event.damage); this.absorption -= absorbed;
    this.health = Math.max(0, this.health - (event.damage - absorbed)); this.sync();
    this.player.server.broadcast(new PacketWriter(0x29).writeVarInt(this.player.entityId).writeFloat(this.player.yaw));
    return true;
  }
  private effectLevel(name: string): number { const effect = this.effects.get(name); return effect && effect.expiresAt > this.now() ? effect.amplifier + 1 : 0; }
  private blocks(attacker: Player): boolean {
    if (this.now() < this.shieldDisabledUntil || this.now() - this.blockingSince < 250 || this.blockingSlot < 0) return false;
    if (this.blockingSlot !== 45 && this.blockingSlot !== 36 + this.player.heldSlot) return false;
    if (itemName(this.player.inventory.get(this.blockingSlot)?.itemId ?? -1) !== 'shield') return false;
    const yaw = this.player.yaw * Math.PI / 180;
    return -Math.sin(yaw) * (attacker.x - this.player.x) + Math.cos(yaw) * (attacker.z - this.player.z) > 0;
  }
  private armor(): { points: number; toughness: number; protection: number } {
    let points = 0, toughness = 0, protection = 0;
    const values: Record<string, number[]> = { leather: [1,3,2,1], golden: [2,5,3,1], chainmail: [2,5,4,1], iron: [2,6,5,2], diamond: [3,8,6,3], netherite: [3,8,6,3], copper: [2,4,3,1], turtle: [2,0,0,0] };
    for (let slot = 5; slot <= 8; slot++) {
      const item = this.player.inventory.get(slot), name = itemName(item?.itemId ?? -1) ?? '';
      const material = name.split('_')[0];
      if (!name.endsWith(['_helmet','_chestplate','_leggings','_boots'][slot - 5])) continue;
      points += values[material]?.[slot - 5] ?? 0; toughness += material === 'diamond' ? 2 : material === 'netherite' ? 3 : 0;
      protection += enchantment(item, 'protection');
    }
    return { points, toughness, protection };
  }
}
function glassBottleId(): number { return itemId('glass_bottle')!; }
function weaponStats(name: string): { damage: number; speed: number } {
  const material = name.split('_')[0];
  if (name.endsWith('_sword')) return { damage: ({ wooden:4, golden:4, stone:5, copper:5, iron:6, diamond:7, netherite:8 } as Record<string,number>)[material] ?? 1, speed:1.6 };
  if (name.endsWith('_axe')) return { damage: ({ wooden:7, golden:7, stone:9, copper:9, iron:9, diamond:9, netherite:10 } as Record<string,number>)[material] ?? 1, speed: material === 'wooden' || material === 'stone' ? 0.8 : material === 'iron' || material === 'copper' ? 0.9 : 1 };
  return { damage:1, speed:4 };
}
