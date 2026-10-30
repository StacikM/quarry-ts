/**
 * Joins the real server over a real socket with minecraft-protocol, an independent
 * implementation of the 1.21.11 protocol that we did not write, and checks what it sees:
 * login, configuration, the chunks (compared block for block with the server's world),
 * chat, commands, placing and breaking blocks, and the Velocity proxy handshake.
 * Run with:  npx tsx scripts/join-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or ops.json.
 */
import assert from "node:assert";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-join-"));
process.chdir(workDir);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mc = require("minecraft-protocol");

function quiet<T>(fn: () => T): T {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()` is true, or fails after `ms`. */
async function until(ready: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(20);
  }
}

/** One of our own checks: reads a chunk's section data with plain BigInt maths, not the encoder's bit tricks. */
function readBlocks(chunkData: Buffer, blockBits: number): Uint16Array[] {
  let at = 0;
  const varInt = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = chunkData[at++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
  };
  const container = (size: number, maxPaletteBits: number, directBits: number): Uint16Array => {
    const bits = chunkData[at++];
    const values = new Uint16Array(size);
    if (bits === 0) {
      values.fill(varInt());
      return values;
    }
    const palette: number[] | null = bits <= maxPaletteBits ? Array.from({ length: varInt() }, () => varInt()) : null;
    assert.strictEqual(bits, palette ? bits : directBits, "direct containers use the full bit width");
    const perLong = Math.floor(64 / bits);
    const longCount = Math.ceil(size / perLong); // no length is sent: it follows from the bits per entry
    for (let i = 0; i < size; i++) {
      const long = chunkData.readBigUInt64BE(at + Math.floor(i / perLong) * 8);
      const entry = Number((long >> BigInt((i % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
      values[i] = palette ? palette[entry] : entry;
    }
    at += longCount * 8;
    return values;
  };

  const sections: Uint16Array[] = [];
  for (let section = 0; section < 24; section++) {
    const count = chunkData.readInt16BE(at);
    at += 2;
    const blocks = container(4096, 8, blockBits);
    container(64, 3, 7); // biomes
    assert.strictEqual(count, blocks.reduce((sum, state) => sum + (state !== 0 ? 1 : 0), 0), `section ${section}: the block count matches`);
    sections.push(blocks);
  }
  assert.strictEqual(at, chunkData.length, "the chunk data is read to the last byte");
  return sections;
}

async function main(): Promise<void> {
  fs.writeFileSync("ops.json", JSON.stringify(["Joiner"]));

  const { config } = await import("../src/config");
  const { MinecraftServer } = await import("../src/game/Server");
  const { stateOf, STATE_COUNT } = await import("../src/world/blockStates");
  const { itemId } = await import("../src/world/blockStates");

  config.port = await freePort();
  config.host = "127.0.0.1";
  config.viewDistance = 3;
  const server = new MinecraftServer();
  quiet(() => server.start());
  const connect = (username: string): any =>
    mc.createClient({ host: "127.0.0.1", port: config.port, username, version: "1.21.11", auth: "offline", skipValidation: true });

  try {
    // ------------------------------------------------------------ a normal join
    {
      const client = connect("Joiner");
      const seen = { login: null as any, position: null as any, chunks: new Map<string, any>(), registries: 0, messages: [] as string[], blocks: [] as any[], acks: [] as number[] };
      client.on("registry_data", () => seen.registries++);
      client.on("login", (packet: any) => (seen.login = packet));
      client.on("position", (packet: any) => (seen.position = packet));
      client.on("map_chunk", (packet: any) => seen.chunks.set(`${packet.x},${packet.z}`, packet));
      client.on("system_chat", (packet: any) => seen.messages.push(JSON.stringify(packet.content)));
      client.on("block_change", (packet: any) => seen.blocks.push(packet));
      client.on("acknowledge_player_digging", (packet: any) => seen.acks.push(packet.sequenceId));
      let kicked: string | null = null;
      client.on("kick_disconnect", (packet: any) => (kicked = JSON.stringify(packet.reason)));
      client.on("error", (err: Error) => (kicked = `client error: ${err.message}`));

      await until(() => seen.chunks.size >= 49 || kicked !== null, "the 7 x 7 chunks around the spawn");
      assert.strictEqual(kicked, null, `joined without being kicked (${kicked})`);
      assert.ok(seen.login, "the client got the Login packet");
      assert.strictEqual(seen.login.worldState.gamemode, "creative");
      assert.strictEqual(seen.registries, 23, "every registry was sent");
      assert.ok(seen.position, "the client got its position");
      assert.ok(client.compressionThreshold >= 0, "packets are compressed");

      // The chunk the player stands in must match the world, block for block.
      const chunkX = Math.floor(seen.position.x / 16);
      const chunkZ = Math.floor(seen.position.z / 16);
      const received = seen.chunks.get(`${chunkX},${chunkZ}`);
      assert.ok(received, "the chunk under the player arrived");
      const sections = readBlocks(received.chunkData, Math.ceil(Math.log2(STATE_COUNT)));
      const world = quiet(() => server.world.getChunk(chunkX, chunkZ));
      let compared = 0;
      for (let y = 0; y < 256; y++) {
        for (let i = 0; i < 256; i++) {
          const fromClient = sections[4 + (y >> 4)][((y & 15) << 8) | i];
          assert.strictEqual(fromClient, world.getRawBlocks()[(y << 8) | i], `block ${i & 15},${y},${i >> 4} matches the world`);
          compared++;
        }
      }
      assert.strictEqual(compared, 65536);
      for (const section of [...sections.slice(0, 4), ...sections.slice(20)]) {
        assert.ok(section.every((state) => state === 0), "below y=0 and above y=255 is air");
      }
      assert.strictEqual(received.skyLight.length, 21, "sky light for 16 stored sections plus 5 above");
      assert.strictEqual(received.blockLight.length, 16);
      assert.ok(received.heightmaps.length === 2);

      // Chat and commands.
      client.write("chat_command", { command: "list" });
      await until(() => seen.messages.length >= 1, "the answer to /list");
      assert.ok(seen.messages.join("").includes("Joiner"), "/list names the player");
      client.write("chat_message", { message: "hello <world> §c", timestamp: BigInt(Date.now()), salt: 0n, offset: 0, acknowledged: Buffer.alloc(3), checksum: 0 });
      await until(() => seen.messages.some((message) => message.includes("hello")), "the chat line");
      assert.ok(seen.messages.some((message) => message.includes("hello <world> c")), "the typed section sign is stripped, the rest stays (the server's own colours are fine)");

      // Placing a block: put stone in the hotbar, click the top of the block under the player's feet.
      const floor = { x: Math.floor(seen.position.x), y: Math.floor(seen.position.y) - 1, z: Math.floor(seen.position.z) };
      const stone = itemId("stone");
      assert.ok(stone !== undefined);
      client.write("set_creative_slot", { slot: 36, item: { itemCount: 1, itemId: stone, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } });
      client.write("held_item_slot", { slotId: 0 });
      client.write("position", { x: seen.position.x, y: seen.position.y, z: seen.position.z, flags: { onGround: true, hasHorizontalCollision: false } });
      client.write("teleport_confirm", { teleportId: seen.position.teleportId });
      await sleep(100);
      client.write("block_place", { hand: 0, location: floor, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: 41 });
      await until(() => seen.acks.includes(41), "the acknowledgement of the placement");
      assert.strictEqual(quiet(() => server.world.getState({ x: floor.x, y: floor.y + 1, z: floor.z })), stateOf("stone"), "the stone is in the world");
      assert.ok(seen.blocks.some((block) => block.location.y === floor.y + 1 && block.type === stateOf("stone")), "and the client was told");

      // Breaking it again (creative: status 0).
      client.write("block_dig", { status: 0, location: { x: floor.x, y: floor.y + 1, z: floor.z }, face: 1, sequence: 42 });
      await until(() => seen.acks.includes(42), "the acknowledgement of the break");
      assert.strictEqual(quiet(() => server.world.getState({ x: floor.x, y: floor.y + 1, z: floor.z })), 0, "the stone is gone");

      // Garbage coordinates must not move the player.
      const before = server.getOnlinePlayers()[0].x;
      client.write("position", { x: Number.NaN, y: 70, z: 0, flags: { onGround: true, hasHorizontalCollision: false } });
      await sleep(100);
      assert.strictEqual(server.getOnlinePlayers()[0].x, before, "NaN positions are ignored");

      client.end();
      await until(() => server.getOnlinePlayers().length === 0, "the player to leave");
      console.log("ok direct join: login, 23 registries, compression, 49 chunks, a chunk matching the world block for block, chat, command, place, break");
    }

    // ------------------------------------------------------------ Velocity
    {
      const secret = "proxy-secret";
      config.velocity = { enabled: true, secret };
      const forwardingPayload = (name: string, uuid: string, ip: string, key = secret): Buffer => {
        const varInt = (value: number): Buffer => Buffer.from([value]);
        const text = (value: string): Buffer => Buffer.concat([varInt(Buffer.byteLength(value)), Buffer.from(value)]);
        const signed = Buffer.concat([varInt(1), text(ip), Buffer.from(uuid.replace(/-/g, ""), "hex"), text(name), varInt(0)]);
        return Buffer.concat([createHmac("sha256", key).update(signed).digest(), signed]);
      };
      const viaProxy = (name: string, answer: (messageId: number) => Buffer | undefined): any => {
        const client = connect(name);
        client.removeAllListeners("login_plugin_request"); // the library would otherwise answer "not understood" by itself
        client.on("login_plugin_request", (packet: any) => {
          assert.strictEqual(packet.channel, "velocity:player_info");
          client.write("login_plugin_response", { messageId: packet.messageId, data: answer(packet.messageId) });
        });
        return client;
      };

      // A correctly signed login: the proxy's name, UUID and address are used.
      const uuid = randomUUID();
      const good = viaProxy("Proxied", () => forwardingPayload("Proxied", uuid, "203.0.113.9"));
      let goodEnded = false;
      good.on("end", () => (goodEnded = true));
      good.on("error", () => {});
      await until(() => server.getOnlinePlayers().length === 1, "the proxied player to join");
      const player = server.getOnlinePlayers()[0];
      assert.strictEqual(player.username, "Proxied");
      assert.strictEqual(player.uuid, uuid, "the proxy's UUID is used");
      assert.strictEqual(player.ip, "203.0.113.9", "the player's real address, not the proxy's");

      // Bans use the real address.
      quiet(() => server.bans.banIp("203.0.113.9", "test", "Console"));
      const banned = viaProxy("Other", () => forwardingPayload("Other", randomUUID(), "203.0.113.9"));
      let bannedReason = "";
      banned.on("disconnect", (packet: any) => (bannedReason = JSON.stringify(packet.reason)));
      banned.on("error", () => {});
      await until(() => bannedReason !== "", "the ban to be reported");
      assert.ok(bannedReason.includes("banned"), "a banned address is turned away even behind a proxy");
      quiet(() => server.bans.unbanIp("203.0.113.9"));

      // A wrong signature, and a client that does not know the proxy protocol, are both turned away.
      for (const [label, answer] of [
        ["wrong secret", () => forwardingPayload("Evil", randomUUID(), "198.51.100.1", "guessed")],
        ["no proxy", () => undefined],
      ] as const) {
        const client = viaProxy("Intruder", answer);
        let reason = "";
        client.on("disconnect", (packet: any) => (reason = JSON.stringify(packet.reason)));
        client.on("error", () => {});
        await until(() => reason !== "", `the ${label} login to be refused`);
      }
      assert.strictEqual(server.getOnlinePlayers().length, 1, "nobody else got in");

      good.end();
      await until(() => goodEnded && server.getOnlinePlayers().length === 0, "the proxied player to leave");
      config.velocity = { enabled: false, secret: "" };
      console.log("ok velocity: signed login accepted with the proxy's identity and address, bans use the real address, wrong secret and direct connections refused");
    }

    // ------------------------------------------------------------ the server list
    {
      const status: any = await new Promise((resolve, reject) =>
        mc.ping({ host: "127.0.0.1", port: config.port, version: "1.21.11" }, (err: Error | null, result: unknown) => (err ? reject(err) : resolve(result))),
      );
      assert.strictEqual(status.version.protocol, 774);
      assert.strictEqual(status.version.name, "1.21.11");
      assert.strictEqual(status.players.online, 0);
      console.log("ok status: the server list shows 1.21.11 / protocol 774");
    }
  } finally {
    quiet(() => server.stop());
    process.chdir(os.tmpdir());
  }
  console.log("ALL JOIN CHECKS PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
