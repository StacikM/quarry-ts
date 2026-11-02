import { config } from "../config";
import type { Player } from "./Player";

interface Snapshot {
  expires: number;
  permissions: Readonly<Record<string, boolean>>;
  prefix: string;
}

/** Short-lived grants received from the authenticated Velocity permission bridge. */
export class ProxyPermissions {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  accept(player: Player, payload: Buffer): boolean {
    if (!config.velocity.enabled || payload.length > 16_384) return false;
    try {
      const data = JSON.parse(payload.toString("utf8"));
      if (!data || data.uuid !== player.uuid || typeof data.permissions !== "object" || !data.permissions || Array.isArray(data.permissions)) return false;
      const permissions: Record<string, boolean> = Object.create(null);
      for (const [node, allowed] of Object.entries(data.permissions)) {
        if (!/^[a-z0-9_.-]{1,128}$/.test(node) || typeof allowed !== "boolean") return false;
        permissions[node] = allowed;
      }
      this.snapshots.set(player.uuid, {
        expires: this.now() + 10_000,
        permissions,
        prefix: typeof data.prefix === "string" ? data.prefix.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) : "",
      });
      player.syncPermissionLevel();
      return true;
    } catch {
      return false;
    }
  }

  has(uuid: string, node: string): boolean {
    const snapshot = this.snapshots.get(uuid);
    return !!snapshot && snapshot.expires > this.now() && snapshot.permissions[node] === true;
  }

  prefix(uuid: string): string {
    const snapshot = this.snapshots.get(uuid);
    return snapshot && snapshot.expires > this.now() ? snapshot.prefix : "";
  }

  forget(uuid: string): void {
    this.snapshots.delete(uuid);
  }
}
