import type { Plugin } from "../types";
import { copyPosition, isPosition, loadPositions } from "./data";

export const homePlugin: Plugin = {
  name: "homes",
  version: "1.0.0",
  onEnable(api) {
    let homes = loadPositions(api);
    api.registerCommand({
      name: "sethome", description: "Save your current position as home",
      run(player) {
        const position = copyPosition(player);
        if (!isPosition(position)) { player.sendMessage("Choose a home inside the world.", "red"); return; }
        const next = { ...homes, [player.username.toLowerCase()]: position };
        api.saveData(next);
        homes = next;
        player.sendMessage("Home saved. Use /home to return.", "green");
      },
    });
    api.registerCommand({
      name: "home", description: "Teleport to your saved home",
      run(player) {
        const key = player.username.toLowerCase();
        const home = Object.hasOwn(homes, key) ? homes[key] : undefined;
        if (!home) { player.sendMessage("Set a home first with /sethome.", "red"); return; }
        player.teleport(home.x, home.y, home.z);
        player.sendMessage("Welcome home.", "green");
      },
    });
  },
};
