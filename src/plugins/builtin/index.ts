import type { Plugin } from "../types";
import { homePlugin } from "./home";
import { warpPlugin } from "./warp";
import { protectPlugin } from "./protect";
import { welcomePlugin } from "./motd/welcome";
import { chatFormatPlugin } from "./chatfmt";

/**
 * Plugins that ship with the server. Add yours here:
 *   import { welcomePlugin } from "./welcome";
 *   export const builtinPlugins: Plugin[] = [welcomePlugin];
 */
export const builtinPlugins: Plugin[] = [homePlugin, warpPlugin, protectPlugin, welcomePlugin, chatFormatPlugin];
