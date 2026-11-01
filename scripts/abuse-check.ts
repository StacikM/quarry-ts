/**
 * Checks the protection against port scanners: junk connections are summed up instead of logged one by one,
 * and one address cannot hold unlimited connections open.
 * Run with:  npx tsx scripts/abuse-check.ts
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-abuse-"));
process.chdir(workDir);

/** Enough of a socket for the Connection class. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  ended = false;
  constructor(readonly remoteAddress: string, readonly remotePort = 40000) {
    super();
  }
  setNoDelay(): void {}
  write(): boolean {
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { Connection } = await import("../src/network/Connection");
  const { ConnectionState } = await import("../src/network/ConnectionState");
  const { admit, reportJunk, MAX_CONNECTIONS_PER_IP } = await import("../src/network/abuse");
  const { config } = await import("../src/config");

  // ---------------------------------------------------------------- the limit per address
  {
    const releases = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
      const release = admit(new FakeSocket("203.0.113.5") as never);
      assert.ok(release, `connection ${i + 1} is let in`);
      releases.push(release!);
    }
    assert.strictEqual(admit(new FakeSocket("203.0.113.5") as never), null, "one more from the same address is refused");
    assert.strictEqual(admit(new FakeSocket("::ffff:203.0.113.5") as never), null, "also written as an IPv4-mapped IPv6 address");
    const other = admit(new FakeSocket("203.0.113.6") as never);
    assert.ok(other, "another address is not affected");
    other!();
    releases[0]();
    releases[0](); // closing twice must not free two places
    const again = admit(new FakeSocket("203.0.113.5") as never);
    assert.ok(again, "a closed connection frees a place");
    assert.strictEqual(admit(new FakeSocket("203.0.113.5") as never), null, "...exactly one");
    config.velocity.enabled = true;
    assert.ok(admit(new FakeSocket("203.0.113.5") as never), "behind a proxy every player has the proxy's address: no limit");
    config.velocity.enabled = false;
    console.log("ok connections per address are limited");
  }

  // ---------------------------------------------------------------- junk is summed up
  {
    const lines: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (line: string) => lines.push(`WARN ${line}`);
    console.log = (line: string) => lines.push(`INFO ${line}`);
    try {
      const server = new MinecraftServer();
      lines.length = 0; // the world announcing itself
      const scan = (address: string, bytes: number[], state = ConnectionState.Handshaking): InstanceType<typeof FakeSocket> => {
        const socket = new FakeSocket(address, 55000);
        const connection = new Connection(socket as never, server);
        connection.state = state;
        socket.emit("data", Buffer.from(bytes));
        return socket;
      };
      const first = scan("198.51.100.1", [0x01, 0x80]); // a packet whose VarInt never ends
      scan("198.51.100.2", [0x03, 0x00, 0x05, 0x14]); // a handshake that stops where a 20 byte string should start
      scan("198.51.100.2", [0x03, 0x00, 0x05, 0x14]);
      assert.ok(first.ended, "the connection is closed");
      assert.deepStrictEqual(lines, [], "nothing is printed for each of them");

      reportJunk();
      assert.strictEqual(lines.length, 1, "one line sums them up");
      assert.match(lines[0], /^INFO .*Ignored 3 junk connection\(s\) from 2 address\(es\)/);
      assert.match(lines[0], /VarInt x1/);
      assert.ok(lines[0].includes("Packet ended early (wanted N more bytes) x2"), "numbers are left out, so the same kind of junk adds up");
      reportJunk();
      assert.strictEqual(lines.length, 1, "and nothing is said when nothing happened");

      // A client that got as far as logging in and then sends nonsense is still reported on its own.
      lines.length = 0;
      scan("198.51.100.3", [0x01, 0x80], ConnectionState.Login);
      assert.strictEqual(lines.length, 1);
      assert.match(lines[0], /^WARN .*Error from 198\.51\.100\.3:55000: Packet ended in the middle of a VarInt/);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
    console.log("ok junk connections are summed up");
  }

  console.log("ALL ABUSE CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("ABUSE CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
