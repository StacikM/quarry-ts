import type { Plugin, ServerEvents } from "../types";

export const protectPlugin: Plugin = {
  name: "spawn-protection", version: "1.0.0",
  onEnable(api) {
    const spawn = api.server.getSpawnPoint();
    const radius = 16;
    const protect = (event: ServerEvents["blockBreak"] | ServerEvents["blockPlace"]): void => {
      if (event.cancelled || event.player.isOp) return;
      // Positions are block coordinates; compare the centers of the blocks.
      if (Math.hypot(event.position.x + 0.5 - spawn.x, event.position.z + 0.5 - spawn.z) <= radius) {
        event.cancelled = true;
        event.player.sendMessage("Spawn is protected within 16 blocks. Build farther away.", "yellow");
      }
    };
    api.on("blockBreak", protect);
    api.on("blockPlace", protect);
  },
};
