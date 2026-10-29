import type { Plugin } from "../types";

export const chatFormatPlugin: Plugin = {
  name: "chat-format", version: "1.0.0",
  onEnable(api) {
    api.on("playerChat", (event) => {
      if (event.cancelled) return;
      const prefix = event.player.isOp ? "\u00a7c[OP]" : "\u00a77[Player]";
      // The server substitutes the final message after all moderation handlers.
      event.format = `${prefix} \u00a7f<{player}> \u00a77{message}`;
    });
  },
};
