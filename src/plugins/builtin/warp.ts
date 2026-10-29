import type { Plugin } from "../types";
import { copyPosition, isPosition, loadPositions } from "./data";

const validName = (name: string): boolean => /^[a-z0-9_-]{1,24}$/.test(name);

export const warpPlugin: Plugin = {
  name: "warps", version: "1.0.0",
  onEnable(api) {
    let warps = Object.fromEntries(Object.entries(loadPositions(api)).filter(([name]) => validName(name)));
    api.registerCommand({
      name: "setwarp", description: "Create or update a public warp", usage: "/setwarp <name>", opOnly: true,
      run(player, args) {
        const name = args[0]?.toLowerCase() ?? "";
        if (args.length !== 1 || !validName(name)) {
          player.sendMessage("Usage: /setwarp <name> (1-24 letters, digits, _ or -)", "red"); return;
        }
        const position = copyPosition(player);
        if (!isPosition(position)) { player.sendMessage("Choose a warp inside the world.", "red"); return; }
        const next = { ...warps, [name]: position };
        api.saveData(next);
        warps = next;
        player.sendMessage(`Warp ${name} saved.`, "green");
      },
    });
    api.registerCommand({
      name: "warp", description: "Teleport to a public warp", usage: "/warp <name>",
      run(player, args) {
        const name = args[0]?.toLowerCase() ?? "";
        const warp = Object.hasOwn(warps, name) ? warps[name] : undefined;
        if (args.length !== 1 || !warp) { player.sendMessage("Unknown warp. Use /warps to list them.", "red"); return; }
        player.teleport(warp.x, warp.y, warp.z);
        player.sendMessage(`Teleported to ${name}.`, "green");
      },
    });
    api.registerCommand({
      name: "warps", description: "List public warps",
      run(player) { player.sendMessage(`Warps: ${Object.keys(warps).sort().join(", ") || "none yet"}`, "gold"); },
    });
  },
};
