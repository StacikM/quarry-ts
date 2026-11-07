import { randomUUID } from 'node:crypto';
import { PacketWriter } from '../network/PacketWriter';
import { entityPositionSync, destroyEntities } from '../protocol/clientbound';
import { isFullCube } from '../world/blockShapes';
import type { MinecraftServer } from './Server';
import type { Player } from './Player';

interface Arrow { id:number; owner:Player; uuid:string; x:number;y:number;z:number;vx:number;vy:number;vz:number;power:number;critical:boolean;age:number }
/** Short-lived, server-simulated duel arrows. No client hit report is trusted. */
export class Projectiles {
  private readonly arrows=new Map<number,Arrow>();
  constructor(private readonly server:MinecraftServer){}
  shoot(owner:Player,charge:number,power:number):void {
    const yaw=owner.yaw*Math.PI/180,pitch=owner.pitch*Math.PI/180,speed=3*charge;
    const arrow:Arrow={id:this.server.allocateEntityId(),owner,uuid:randomUUID(),x:owner.x,y:owner.y+1.52,z:owner.z,
      vx:-Math.sin(yaw)*Math.cos(pitch)*speed,vy:-Math.sin(pitch)*speed,vz:Math.cos(yaw)*Math.cos(pitch)*speed,power,critical:charge>=1,age:0};
    this.arrows.set(arrow.id,arrow);
    this.server.broadcast(new PacketWriter(0x01).writeVarInt(arrow.id).writeUUID(arrow.uuid).writeVarInt(6)
      .writeDouble(arrow.x).writeDouble(arrow.y).writeDouble(arrow.z).writeVelocity(arrow.vx,arrow.vy,arrow.vz)
      .writeAngle(owner.pitch).writeAngle(owner.yaw).writeAngle(owner.yaw).writeVarInt(owner.entityId+1));
  }
  removeOwned(owner:Player):void { for(const arrow of this.arrows.values())if(arrow.owner===owner)this.remove(arrow); }
  private remove(arrow:Arrow):void {if(this.arrows.delete(arrow.id))this.server.broadcast(destroyEntities([arrow.id]));}
  tick():void {
    for(const arrow of this.arrows.values()){
      if(++arrow.age>200||arrow.owner.moyActivity!=='duel'){this.remove(arrow);continue;}
      const length=Math.hypot(arrow.vx,arrow.vy,arrow.vz),steps=Math.max(1,Math.ceil(length/.1));let hit=false;
      for(let n=1;n<=steps;n++){
        const x=arrow.x+arrow.vx*n/steps,y=arrow.y+arrow.vy*n/steps,z=arrow.z+arrow.vz*n/steps;
        if(isFullCube(this.server.world.getState({x:Math.floor(x),y:Math.floor(y),z:Math.floor(z)}))){hit=true;break;}
        const target=this.server.getOnlinePlayers().find(p=>p!==arrow.owner&&p.gameMode!==3&&Math.abs(p.x-x)<=.45&&Math.abs(p.z-z)<=.45&&y>=p.y-.1&&y<=p.y+1.9);
        if(target){let damage=(2+(arrow.power>0?(arrow.power+1)*.5:0))*length;
          if(arrow.critical)damage+=Math.random()*(damage/2+2);
          target.combat.damage(Math.ceil(damage),arrow.owner,'arrow');hit=true;break;}
      }
      if(hit){this.remove(arrow);continue;}
      arrow.x+=arrow.vx;arrow.y+=arrow.vy;arrow.z+=arrow.vz;arrow.vx*=.99;arrow.vy=arrow.vy*.99-.05;arrow.vz*=.99;
      const yaw=Math.atan2(-arrow.vx,arrow.vz)*180/Math.PI,pitch=Math.atan2(-arrow.vy,Math.hypot(arrow.vx,arrow.vz))*180/Math.PI;
      this.server.broadcast(entityPositionSync(arrow.id,arrow.x,arrow.y,arrow.z,yaw,pitch));
    }
  }
}
