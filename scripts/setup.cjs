#!/usr/bin/env node
/**
 * Interactive setup for a new server: asks a few questions and writes server.json,
 * velocity.json (if you use a Velocity proxy) and ops.json in the current folder.
 * Run by install.sh / install.bat, or on its own:  node scripts/setup.cjs
 *
 * Press Enter to accept the answer shown in [brackets]. Use --defaults to answer everything with the defaults.
 * It only uses Node's own modules, so it works before (or without) npm install.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { randomBytes } = require("node:crypto");

/** The files to write for a set of answers. Pure: it touches nothing, so it can be tested. */
function buildFiles(answers) {
  const server = {
    port: answers.port,
    motd: answers.motd,
    maxPlayers: answers.maxPlayers,
    viewDistance: answers.viewDistance,
    generator: answers.generator,
    protectWorld: answers.protectWorld,
  };
  if (answers.seed !== undefined) server.seed = answers.seed;
  if (answers.mapFolder) server.mapFolder = answers.mapFolder;

  const files = { "server.json": server };
  if (answers.velocitySecret) files["velocity.json"] = { enabled: true, secret: answers.velocitySecret };
  if (answers.ops.length > 0) files["ops.json"] = answers.ops;
  return files;
}

/** Reads typed lines one at a time. When the input ends (a pipe, Ctrl+D) every remaining question gets its default. */
function createAsker(input, output) {
  const rl = readline.createInterface({ input });
  const waiting = [];
  const lines = [];
  let closed = false;
  rl.on("line", (line) => (waiting.length > 0 ? waiting.shift()(line) : lines.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length > 0) waiting.shift()(undefined);
  });
  const next = () => new Promise((resolve) => (lines.length > 0 ? resolve(lines.shift()) : closed ? resolve(undefined) : waiting.push(resolve)));

  return {
    /** Asks until `check` accepts the answer (it returns the value, or throws an Error saying what is wrong). */
    async ask(question, fallback, check = (text) => text) {
      for (;;) {
        output.write(fallback === undefined || fallback === "" ? `${question}: ` : `${question} [${fallback}]: `);
        const typed = await next();
        if (typed === undefined) {
          output.write("\n");
          return check(String(fallback ?? ""));
        }
        const text = typed.trim() === "" ? String(fallback ?? "") : typed.trim();
        try {
          return check(text);
        } catch (err) {
          output.write(`  ${err.message}\n`);
        }
      }
    },
    close: () => rl.close(),
  };
}

const whole = (min, max, what) => (text) => {
  const number = Number(text);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${what} must be a whole number from ${min} to ${max}.`);
  return number;
};
const yesNo = (text) => {
  if (/^(y|yes|true)$/i.test(text)) return true;
  if (/^(n|no|false)$/i.test(text)) return false;
  throw new Error("Please answer y or n.");
};

async function interview(asker, say, defaultsOnly) {
  const ask = defaultsOnly ? async (_question, fallback, check = (text) => text) => check(String(fallback ?? "")) : asker.ask;

  say("\nBasics");
  const port = await ask("  Port players connect to", 25565, whole(1, 65535, "The port"));
  const motd = await ask("  Server list text (MOTD)", "A Minecraft server written in TypeScript");
  const maxPlayers = await ask("  Maximum players", 20, whole(1, 100000, "The number of players"));
  const viewDistance = await ask("  View distance in chunks (lower = less memory)", 6, whole(2, 32, "The view distance"));

  say("\nWorld\n  1) Natural terrain (hills, trees, caves of ore)\n  2) Flat\n  3) Void: an empty world with a small platform (good for lobbies)\n  4) Import an existing map folder (a 1.18 or newer world)");
  const kind = await ask("  Choose", 1, whole(1, 4, "The choice"));
  const generator = { 1: "natural", 2: "flat", 3: "void", 4: "void" }[kind];
  let seed;
  let mapFolder = "";
  if (kind === 1) {
    const typed = await ask("  World seed (Enter for a random one, different on every server)", "");
    if (typed !== "") seed = Number.isSafeInteger(Number(typed)) ? Number(typed) : typed; // text seeds are turned into a number by the server, like in vanilla
  }
  if (kind === 4) {
    mapFolder = await ask("  Folder of the map (the one that contains \"region\")", "", (text) => {
      if (text === "") throw new Error("Please give a folder.");
      if (!fs.existsSync(path.join(path.resolve(text), "region"))) {
        say(`  Warning: ${path.resolve(text)}${path.sep}region does not exist (yet). The server will refuse to start until it does.`);
      }
      return text;
    });
  }
  const protectWorld = await ask("  Lobby protection (only operators can build or break, everybody else is in adventure mode)?", kind >= 3 ? "y" : "n", yesNo);

  say("\nVelocity proxy");
  let velocitySecret = "";
  if (await ask("  Will this server sit behind a Velocity proxy?", "n", yesNo)) {
    const typed = await ask("  Forwarding secret (the text in Velocity's forwarding.secret; Enter to make one up)", "");
    velocitySecret = typed || randomBytes(12).toString("base64url");
    if (!typed) say(`  Made up the secret: ${velocitySecret}\n  Put exactly this in Velocity's forwarding.secret, and set player-info-forwarding-mode = "modern".`);
  }

  say("\nOperators");
  const opsText = await ask("  Operator names, separated by commas (Enter for none)", "");
  const ops = opsText.split(",").map((name) => name.trim()).filter((name) => name !== "");

  return { port, motd, maxPlayers, viewDistance, generator, seed, mapFolder, protectWorld, velocitySecret, ops };
}

async function main() {
  const defaultsOnly = process.argv.includes("--defaults");
  const say = (text) => process.stdout.write(`${text}\n`);
  const asker = createAsker(process.stdin, process.stdout);

  say("Quarry.ts setup. Press Enter to accept the answer in [brackets].");
  if (fs.existsSync("server.json") && !defaultsOnly) {
    const overwrite = await asker.ask("server.json already exists. Replace it with new answers?", "n", yesNo);
    if (!overwrite) {
      say("Leaving your files as they are.");
      asker.close();
      return;
    }
  }

  const answers = await interview(asker, say, defaultsOnly);
  asker.close();

  // Keep the operators and the secret that are already there when the answers add to them.
  if (fs.existsSync("ops.json")) {
    try {
      const existing = JSON.parse(fs.readFileSync("ops.json", "utf8"));
      if (Array.isArray(existing)) answers.ops = [...new Set([...existing.filter((name) => typeof name === "string"), ...answers.ops])];
    } catch {
      say("Note: ops.json could not be read, so it is being replaced.");
    }
  }

  say("");
  for (const [file, content] of Object.entries(buildFiles(answers))) {
    fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
    say(`Wrote ${file}`);
  }
  say("\nDone. Start the server with:  npm start");
  if (answers.generator === "natural" && answers.seed === undefined) say("(The random seed is made when the server first starts and kept in world/seed.txt.)");
  say("To change a setting later, edit server.json, or run this setup again.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Setup failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildFiles };
