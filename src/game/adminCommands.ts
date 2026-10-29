import v8 from "node:v8";
import type { CommandSender, PluginCommand } from "../plugins/types";
import type { MinecraftServer } from "./Server";
import { colour, sendUsage, senderCommand } from "./commandSupport";
import { isOperatorName } from "./operators";
import { banMessage, cleanReason } from "./bans";
import { formatBytes, TARGET_TPS } from "./stats";
import { isIpAddress, normalizeIp } from "../util/ip";
import { VALID_USERNAME } from "../util/username";
import { formatError, logger } from "../util/logger";

/**
 * Profiling commands (/tps, /mem, /perf) and moderation commands (/kick, /ban,
 * /unban, /banip, /unbanip, /banlist), plus /say and /save.
 *
 * Every one is a senderCommand, so it works the same typed in game or in the
 * server console. Moderation commands can only be used by operators.
 */

// ------------------------------------------------------------------ profiling

function tpsText(tps: number): string {
  const colourFor = tps >= 19 ? colour.green : tps >= 15 ? colour.yellow : colour.red;
  return `${colourFor}${tps.toFixed(1)}`;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Ticks per second, how long each tick takes, and how long the program stalls. */
function tpsLines(server: MinecraftServer): string[] {
  const stats = server.stats;
  const tick = stats.tickTime();
  const lines = [
    `${colour.gold}TPS (1m, 5m, 15m): ${tpsText(stats.tps(60))}${colour.gray}, ${tpsText(stats.tps(300))}${colour.gray}, ${tpsText(stats.tps(900))}` +
      `${colour.gray}  (${TARGET_TPS.toFixed(0)} is perfect)`,
    `${colour.gray}Work per tick: average ${tick.averageMs.toFixed(2)} ms, worst ${tick.maxMs.toFixed(2)} ms (a tick has 50 ms)`,
  ];

  const loop = stats.eventLoop();
  if (loop) {
    const minutes = Math.max(1, Math.round(loop.sinceSeconds / 60));
    lines.push(
      `${colour.gray}Delays (last ~${minutes} min): average ${loop.meanMs.toFixed(1)} ms, 99% under ${loop.p99Ms.toFixed(1)} ms, ` +
        `worst ${loop.maxMs.toFixed(1)} ms`,
    );
    if (loop.maxMs > 100) {
      lines.push(`${colour.yellow}A stall over 50 ms freezes everyone for a moment. Generating many new chunks at once is the usual cause.`);
    }
  }
  return lines;
}

/** How much memory the program uses, and where it goes. */
function memoryLines(server: MinecraftServer): string[] {
  const usage = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const world = server.world.memoryReport();
  const worldTotal = world.blockBytes + world.lightBytes + world.otherBytes;
  const other = Math.max(0, usage.rss - usage.heapTotal - usage.external);

  return [
    `${colour.gold}Memory`,
    `${colour.gray}Whole process (what Task Manager shows): ${colour.white}${formatBytes(usage.rss)}`,
    `${colour.gray}JavaScript heap: ${colour.white}${formatBytes(usage.heapUsed)}${colour.gray} used of ${formatBytes(usage.heapTotal)} reserved ` +
      `(limit ${formatBytes(heapLimit)})`,
    `${colour.gray}Buffers (chunk blocks, light, network): ${colour.white}${formatBytes(usage.arrayBuffers)}`,
    `${colour.gray}Code and everything else: ${colour.white}${formatBytes(other)}`,
    `${colour.gray}World in memory: ${colour.white}${world.chunks} chunks, about ${formatBytes(worldTotal)}${colour.gray} ` +
      `(blocks ${formatBytes(world.blockBytes)}, light ${formatBytes(world.lightBytes)}, other ${formatBytes(world.otherBytes)})`,
  ];
}

/** Where the processor time went: generating and lighting chunks. */
function workLines(server: MinecraftServer): string[] {
  const t = server.world.timings;
  const average = (total: number, count: number): string => (count === 0 ? "0.00" : (total / count).toFixed(2));
  return [
    `${colour.gray}Chunks generated: ${colour.white}${t.chunksGenerated}${colour.gray} (average ${average(t.generateMs, t.chunksGenerated)} ms, ` +
      `slowest ${t.generateMaxMs.toFixed(2)} ms)`,
    `${colour.gray}Chunks lit: ${colour.white}${t.chunksLit}${colour.gray} (average ${average(t.lightMs, t.chunksLit)} ms, ` +
      `slowest ${t.lightMaxMs.toFixed(2)} ms)`,
  ];
}

function send(sender: CommandSender, lines: string[]): void {
  sender.sendMessage(lines.join("\n"));
}

const profilingCommands: PluginCommand[] = [
  senderCommand({
    name: "tps",
    description: "Ticks per second and stalls (20 is perfect)",
    run(sender) {
      send(sender, tpsLines(sender.server));
    },
  }),

  senderCommand({
    name: "mem",
    description: "How much memory the server uses",
    opOnly: true,
    run(sender) {
      send(sender, memoryLines(sender.server));
    },
  }),

  senderCommand({
    name: "perf",
    description: "Everything: uptime, TPS, memory, CPU, chunk work",
    opOnly: true,
    run(sender) {
      const server = sender.server;
      send(sender, [
        `${colour.gold}Quarry.ts performance`,
        `${colour.gray}Up for ${colour.white}${formatDuration(server.stats.uptimeSeconds())}${colour.gray}, ` +
          `${colour.white}${server.getOnlinePlayers().length}${colour.gray} player(s), ` +
          `${colour.white}${server.plugins.getEnabledNames().length}${colour.gray} plugin(s)`,
        `${colour.gray}CPU (last ~5 s): ${colour.white}${server.stats.cpuPercent().toFixed(1)}%${colour.gray} of one core`,
        ...tpsLines(server),
        ...memoryLines(server),
        ...workLines(server),
      ]);
    },
  }),
];

// ----------------------------------------------------------------- moderation

/** Operators can't kick or ban other operators from in game (the console always can). */
function isProtectedFrom(sender: CommandSender, name: string): boolean {
  return !sender.isConsole && isOperatorName(name);
}

/** Shown when bans.json could not be written. Nothing was changed. */
function reportSaveFailure(sender: CommandSender, what: string, err: unknown): void {
  sender.sendMessage(`Could not save bans.json, so ${what}. (${formatError(err).split("\n")[0]})`, "red");
}

const moderationCommands: PluginCommand[] = [
  senderCommand({
    name: "kick",
    usage: "kick <player> [reason]",
    description: "Remove a player from the server",
    opOnly: true,
    run(sender, args) {
      if (args.length < 1) return sendUsage(sender, "kick <player> [reason]");

      const target = sender.server.getPlayerByName(args[0]);
      if (!target) return sender.sendMessage(`${args[0]} is not online.`, "red");
      if (isProtectedFrom(sender, target.username)) {
        return sender.sendMessage("You can't kick an operator. Remove their operator status with /deop first.", "red");
      }

      const reason = cleanReason(args.slice(1).join(" "), "Kicked by an operator.");
      sender.server.broadcastMessage(`${target.username} was kicked by ${sender.name}: ${reason}`, "yellow");
      target.kick(`You were kicked.\nReason: ${reason}`);
    },
  }),

  senderCommand({
    name: "ban",
    usage: "ban <player> [reason]",
    description: "Ban a player by name (they are kicked if online)",
    opOnly: true,
    run(sender, args) {
      const name = args[0];
      if (!name || !VALID_USERNAME.test(name)) return sendUsage(sender, "ban <player name> [reason]");
      if (isProtectedFrom(sender, name)) {
        return sender.sendMessage("You can't ban an operator. Remove their operator status with /deop first.", "red");
      }

      const reason = cleanReason(args.slice(1).join(" "), "Banned by an operator.");
      const bans = sender.server.bans;
      let result;
      try {
        result = bans.banName(name, reason, sender.name);
      } catch (err) {
        return reportSaveFailure(sender, "nobody was banned", err);
      }
      if (result === "already") return sender.sendMessage(`${name} is already banned.`, "yellow");

      sender.server.broadcastMessage(`${name} was banned by ${sender.name}: ${reason}`, "yellow");
      const online = sender.server.getPlayerByName(name);
      const record = bans.findNameBan(name);
      if (online && record) {
        online.kick(banMessage(record));
        sender.sendMessage(`Tip: they can come back under a new name. To block their address too, use: banip ${online.username}`, "gray");
      }
    },
  }),

  senderCommand({
    name: "unban",
    usage: "unban <player>",
    description: "Lift a ban",
    opOnly: true,
    run: unban,
  }),
  senderCommand({
    name: "pardon",
    usage: "pardon <player>",
    description: "Same as unban",
    opOnly: true,
    run: unban,
  }),

  senderCommand({
    name: "banip",
    usage: "banip <player or IP address> [reason]",
    description: "Ban an IP address (or an online player's address)",
    opOnly: true,
    run(sender, args) {
      if (args.length < 1) return sendUsage(sender, "banip <player or IP address> [reason]");

      const server = sender.server;
      const address = isIpAddress(args[0]) ? normalizeIp(args[0]) : server.getPlayerByName(args[0])?.ip;
      if (!address) return sender.sendMessage("Give an IP address, or the name of a player who is online.", "red");

      const affected = server.getOnlinePlayers().filter((p) => p.ip === address);
      if (!sender.isConsole && affected.some((p) => isOperatorName(p.username))) {
        return sender.sendMessage("That address belongs to an operator, so you can't ban it from in game.", "red");
      }

      const reason = cleanReason(args.slice(1).join(" "), "Your address is banned by an operator.");
      let result;
      try {
        result = server.bans.banIp(address, reason, sender.name);
      } catch (err) {
        return reportSaveFailure(sender, "nothing was banned", err);
      }
      if (result === "already") return sender.sendMessage(`${address} is already banned.`, "yellow");

      const record = server.bans.findIpBan(address);
      for (const player of affected) {
        if (record) player.kick(banMessage(record));
      }
      sender.sendMessage(`Banned ${address}. ${affected.length} online player(s) were kicked.`, "green");
      logger.info(`${sender.name} banned IP ${address}: ${reason}`);
      if (address === "127.0.0.1" || address === "::1") {
        sender.sendMessage("Warning: that is this computer's own address, so everyone playing from it is blocked.", "yellow");
      }
    },
  }),

  senderCommand({
    name: "unbanip",
    usage: "unbanip <IP address>",
    description: "Lift an IP ban",
    opOnly: true,
    run(sender, args) {
      if (args.length !== 1 || !isIpAddress(args[0])) return sendUsage(sender, "unbanip <IP address>");
      try {
        const result = sender.server.bans.unbanIp(args[0]);
        sender.sendMessage(result === "unbanned" ? `Unbanned ${normalizeIp(args[0])}.` : `${normalizeIp(args[0])} is not banned.`, result === "unbanned" ? "green" : "yellow");
      } catch (err) {
        reportSaveFailure(sender, "the ban was not lifted", err);
      }
    },
  }),

  senderCommand({
    name: "banlist",
    description: "Show who is banned",
    opOnly: true,
    run(sender) {
      const { bans } = sender.server;
      const names = bans.listNames();
      const ips = bans.listIps();
      const LIMIT = 15;
      const lines = [`${colour.gold}Banned names (${names.length}):`];
      for (const ban of names.slice(0, LIMIT)) {
        lines.push(`${colour.gray}- ${colour.white}${ban.name}${colour.gray}: ${ban.reason} (by ${ban.by}, ${ban.date.slice(0, 10)})`);
      }
      if (names.length > LIMIT) lines.push(`${colour.gray}... and ${names.length - LIMIT} more`);

      lines.push(`${colour.gold}Banned addresses (${ips.length}):`);
      for (const ban of ips.slice(0, LIMIT)) {
        lines.push(`${colour.gray}- ${colour.white}${ban.ip}${colour.gray}: ${ban.reason} (by ${ban.by}, ${ban.date.slice(0, 10)})`);
      }
      if (ips.length > LIMIT) lines.push(`${colour.gray}... and ${ips.length - LIMIT} more`);
      send(sender, lines);
    },
  }),
];

function unban(sender: CommandSender, args: string[]): void {
  if (args.length !== 1) return sendUsage(sender, "unban <player>");
  try {
    const result = sender.server.bans.unbanName(args[0]);
    if (result === "unbanned") sender.sendMessage(`Unbanned ${args[0]}.`, "green");
    else sender.sendMessage(`${args[0]} is not banned.`, "yellow");
  } catch (err) {
    reportSaveFailure(sender, "the ban was not lifted", err);
  }
}

// ---------------------------------------------------------------------- other

const otherCommands: PluginCommand[] = [
  senderCommand({
    name: "say",
    usage: "say <message>",
    description: "Broadcast a message to everyone",
    opOnly: true,
    run(sender, args) {
      const message = cleanReason(args.join(" "), "");
      if (!message) return sendUsage(sender, "say <message>");
      sender.server.broadcastMessage(`[${sender.isConsole ? "Server" : sender.name}] ${message}`, "light_purple");
    },
  }),

  senderCommand({
    name: "save",
    description: "Save the world to disk now",
    opOnly: true,
    run(sender) {
      const { saved, failed } = sender.server.saveWorld({ quiet: true });
      if (failed > 0) sender.sendMessage(`${failed} chunk(s) could NOT be saved. Check the server console.`, "red");
      else sender.sendMessage(`World saved (${saved} chunk file(s) written).`, "green");
    },
  }),
];

export const adminCommands: PluginCommand[] = [...profilingCommands, ...moderationCommands, ...otherCommands];
