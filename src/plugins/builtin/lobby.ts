import type { Plugin } from "../types";
import { config } from "../../config";
import { GameMode } from "../../game/GameMode";

/**
 * Makes the server behave like a lobby when config.lobby.protectWorld is on:
 * only operators can build or break anything, and everyone else is put in
 * adventure mode when they join. With the setting off, this plugin does nothing.
 */
export const lobbyPlugin: Plugin = {
  name: "lobby",
  version: "1.0.0",
  onEnable(api) {
    if (!config.lobby.protectWorld) return;

    api.on("playerJoin", ({ player }) => {
      if (!player.isOp && player.gameMode !== GameMode.Adventure) player.setGameMode(GameMode.Adventure);
    });

    const protect = (event: { cancelled: boolean; player: { isOp: boolean } }): void => {
      if (!event.player.isOp) event.cancelled = true;
    };
    api.on("blockBreak", protect);
    api.on("blockPlace", protect);
  },
};
