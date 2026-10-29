import type { Plugin } from "../../types";

const rules = ["Be respectful in chat.", "Do not grief other players' builds.", "Keep spawn clear; build outside its protected area."];

export const welcomePlugin: Plugin = {
  name: "welcome", version: "1.0.0",
  onEnable(api) {
    api.on("playerJoin", ({ player }) => {
      player.sendMessage(`Welcome, ${player.username}!`, "gold");
      player.sendMessage("Use /help for commands, /rules for rules, and /sethome to save your position.", "gray");
    });
    api.registerCommand({
      name: "rules", description: "Read the server rules",
      run(player) { rules.forEach((rule, i) => player.sendMessage(`${i + 1}. ${rule}`, "yellow")); },
    });
  },
};
