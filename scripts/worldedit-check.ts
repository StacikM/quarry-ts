/**
 * Checks the WorldEdit plugin (selecting, filling, copying, undo...) and the new events and packets it needs.
 * Run with:  npx tsx scripts/worldedit-check.ts
 *
 * It works in a temporary folder, so it never touches your real world/ or plugins-data/.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcserver-worldedit-"));
process.chdir(workDir);

async function main(): Promise<void> {
  const { MinecraftServer } = await import("../src/game/Server");
  const { handlePlay } = await import("../src/protocol/handlers/play");
  const { PacketWriter } = await import("../src/network/PacketWriter");
  const { PlayIn, PlayOut } = await import("../src/protocol/packetIds");
  const { GameMode } = await import("../src/game/GameMode");
  const { config } = await import("../src/config");
  const { runCommand } = await import("../src/game/commands");
  const { defaultState, describeState, stateOf } = await import("../src/world/blockStates");
  const { parseMask, parsePattern } = await import("../src/plugins/builtin/worldedit/parse");
  const { MAX_BLOCKS } = await import("../src/plugins/builtin/worldedit/common");
  const { selectionOf } = await import("../src/plugins/builtin/worldedit/session");
  const { chatText, pendingLogin, readerFor } = await import("./support/fakeClient");

  type Packet = InstanceType<typeof PacketWriter>;
  type Pos = { x: number; y: number; z: number };

  const { worldEditPlugin } = await import("../src/plugins/builtin/worldedit");
  const server = new MinecraftServer();
  server.plugins.enable(worldEditPlugin);
  const world = server.world;
  const stone = defaultState("stone");
  const dirt = defaultState("dirt");
  const air = defaultState("air");
  const gold = defaultState("gold_block");

  function client(name: string, uuid: string): { conn: any; sent: Packet[]; player: any } {
    const sent: Packet[] = [];
    const conn = { player: null as unknown, address: "test", clientIp: "127.0.0.1", send: (p: Packet) => sent.push(p), compressionThreshold: -1, sendFrame: () => {}, disconnect: () => {} };
    server.addPlayer(conn as never, pendingLogin(name, uuid));
    const player = conn.player as any;
    player.awaitingTeleport = null;
    player.gameMode = GameMode.Creative;
    sent.length = 0;
    return { conn, sent, player };
  }
  const alice = client("Alice", "00000000-0000-0000-0000-000000000001");
  const bob = client("Bob", "00000000-0000-0000-0000-000000000002");
  config.ops.push("Alice");

  /** What the player was last told in chat. */
  const lastMessage = (who: typeof alice): string => who.sent.map(chatText).filter((t): t is string => t !== null).pop() ?? "";
  const say = (who: typeof alice, command: string): string => {
    who.sent.length = 0;
    runCommand(who.player, command);
    return lastMessage(who);
  };
  const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
  const stateAt = (x: number, y: number, z: number): number => world.getState({ x, y, z });
  const stand = (who: typeof alice, x: number, y: number, z: number, yaw = 0, pitch = 0): void => Object.assign(who.player, { x: x + 0.5, y, z: z + 0.5, yaw, pitch });
  const count = (from: Pos, to: Pos, state: number): number => {
    let found = 0;
    for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) if (stateAt(x, y, z) === state) found++;
    return found;
  };

  const dig = (who: typeof alice, pos: Pos, status = 0): void => {
    handlePlay(who.conn, PlayIn.PlayerAction, readerFor(new PacketWriter(PlayIn.PlayerAction).writeVarInt(status).writePosition(pos).writeByte(1).writeVarInt(1)));
  };
  const rightClick = (who: typeof alice, pos: Pos, hand = 0): void => {
    const packet = new PacketWriter(PlayIn.UseItemOn).writeVarInt(hand).writePosition(pos).writeVarInt(1).writeFloat(0.5).writeFloat(1).writeFloat(0.5).writeBoolean(false).writeBoolean(false).writeVarInt(1);
    handlePlay(who.conn, PlayIn.UseItemOn, readerFor(packet));
  };

  // The edits happen high above the terrain, where there is only air.
  const Y = 150;
  assert.strictEqual(stateAt(0, Y, 0), air);

  // ---------------------------------------------------------------- patterns and masks
  {
    const held = (): number | undefined => undefined;
    assert.strictEqual(parsePattern("stone", held)(), stone);
    assert.strictEqual(parsePattern("minecraft:stone", held)(), stone, "the minecraft: prefix is optional");
    assert.deepStrictEqual(describeState(parsePattern("oak_stairs[facing=north,half=top]", held)()).properties.half, "top");
    // Weighted: the roll decides.
    const rolls = [0.1, 0.6, 0.95];
    let next = 0;
    const pick = parsePattern("50%stone,40%dirt,10%gold_block", held, () => rolls[next++]);
    assert.deepStrictEqual([pick(), pick(), pick()], [stone, dirt, gold], "50/40/10 weights");
    assert.throws(() => parsePattern("notablock", held), /Unknown block/);
    assert.throws(() => parsePattern("oak_stairs[facing=sideways]", held), /Invalid value/);
    assert.throws(() => parsePattern("0%stone", held), /weight/);
    assert.throws(() => parsePattern("hand", held), /Hold a block/);
    assert.strictEqual(parsePattern("hand", () => dirt)(), dirt);
    const mask = parseMask("stone,oak_stairs[facing=north]");
    assert.ok(mask(stone));
    assert.ok(mask(stateOf("oak_stairs", { facing: "north", half: "top" })), "no property mentioned for half: any half matches");
    assert.ok(!mask(stateOf("oak_stairs", { facing: "south" })));
    assert.ok(!mask(dirt));
    console.log("ok patterns and masks");
  }

  // ---------------------------------------------------------------- permission
  stand(bob, 0, Y, 0);
  assert.match(say(bob, "/pos1"), /permission/, "only operators can use WorldEdit");
  assert.match(say(bob, "/set stone"), /permission/);
  console.log("ok non-operators are refused");

  // ---------------------------------------------------------------- selecting
  stand(alice, 10, Y, 10);
  assert.match(say(alice, "/set stone"), /Select a region first/);
  assert.match(say(alice, "/pos1"), /First position set to \(10, 150, 10\)/);
  stand(alice, 14, Y + 2, 12);
  assert.match(say(alice, "/pos2"), /Second position set to \(14, 152, 12\) \(45 blocks\)/, "5 x 3 x 3 blocks");
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(10, Y, 10), max: at(14, Y + 2, 12) });
  assert.match(say(alice, "/size"), /5 x 3 x 3, 45 blocks/);
  console.log("ok pos1 and pos2");

  // ---------------------------------------------------------------- set, undo, redo
  alice.sent.length = 0;
  assert.match(say(alice, "/set stone"), /Set: 45 blocks changed/);
  assert.strictEqual(count(at(10, Y, 10), at(14, Y + 2, 12), stone), 45);
  assert.strictEqual(stateAt(9, Y, 10), air, "nothing outside the selection");
  assert.ok(alice.sent.some((p) => p.packetId === PlayOut.MultiBlockChange), "the players are told with one packet for the section");
  assert.match(say(alice, "/set stone"), /0 blocks changed/, "nothing to change the second time");
  assert.match(say(alice, "/undo"), /Undid 1 edit \(45 blocks\)/);
  assert.strictEqual(count(at(10, Y, 10), at(14, Y + 2, 12), air), 45, "undone");
  assert.match(say(alice, "/redo"), /Redid 1 edit/);
  assert.strictEqual(stateAt(12, Y + 1, 11), stone);
  assert.match(say(alice, "/undo 5"), /Undid 1 edit/, "asking for more than there is undoes what there is");
  assert.match(say(alice, "/undo"), /nothing to undo/);
  console.log("ok set, undo and redo");

  // ---------------------------------------------------------------- replace
  say(alice, "/set stone");
  assert.match(say(alice, "/replace stone dirt"), /Replace: 45 blocks changed/);
  assert.strictEqual(count(at(10, Y, 10), at(14, Y + 2, 12), dirt), 45);
  assert.match(say(alice, "/replace stone"), /Replace: 45 blocks changed/, "with one argument every solid block is replaced");
  assert.strictEqual(stateAt(10, Y, 10), stone, "...by that one");
  assert.match(say(alice, "/replace stone nope"), /Unknown block: nope/);
  assert.match(say(alice, "/count stone"), /Counted 45\./);
  console.log("ok replace and count");

  // ---------------------------------------------------------------- walls
  say(alice, "/set air");
  assert.match(say(alice, "/walls gold_block"), /Walls: 36 blocks changed/, "the ring of a 5 x 3 box is 12 blocks, three high");
  assert.strictEqual(stateAt(12, Y + 1, 11), air, "the inside is empty");
  assert.strictEqual(stateAt(10, Y + 2, 12), gold);
  console.log("ok walls");

  // ---------------------------------------------------------------- shapes, around the player
  stand(alice, 40, Y + 10, 40);
  assert.match(say(alice, "/sphere stone 1"), /Sphere: 19 blocks changed/);
  assert.strictEqual(stateAt(40, Y + 10, 40), stone);
  assert.strictEqual(stateAt(41, Y + 11, 41), air, "the corners of the 3 x 3 x 3 are left out");
  say(alice, "/undo");
  assert.match(say(alice, "/hsphere stone 1"), /Sphere: 18 blocks changed/);
  assert.strictEqual(stateAt(40, Y + 10, 40), air, "hollow: the middle stays empty");
  say(alice, "/undo");
  assert.match(say(alice, "/sphere -h stone 1"), /18 blocks changed/, "-h also makes it hollow");
  say(alice, "/undo");
  assert.match(say(alice, "/cyl stone 2 3"), /Cylinder: 63 blocks changed/, "a radius 2 disc is 21 blocks, three high");
  assert.strictEqual(stateAt(40, Y + 12, 40), stone);
  assert.strictEqual(stateAt(40, Y + 13, 40), air);
  say(alice, "/undo");
  assert.match(say(alice, "/hcyl stone 2 2"), /Cylinder: 24 blocks changed/, "the ring of that disc is 12 blocks, two high");
  assert.strictEqual(stateAt(40, Y + 10, 40), air);
  say(alice, "/undo");
  assert.match(say(alice, "/sphere stone 500"), /radius/);
  assert.match(say(alice, "/sphere stone 80"), /too many blocks/);
  assert.strictEqual(stateAt(40, Y + 10, 40), air, "a refused edit changes nothing");
  console.log("ok sphere and cylinder");

  // ---------------------------------------------------------------- copy, paste, move, stack
  stand(alice, 10, Y, 10);
  say(alice, "/pos1");
  stand(alice, 12, Y, 11);
  say(alice, "/pos2"); // 3 x 1 x 2 at (10..12, Y, 10..11); the walls from before are there
  say(alice, "/set air");
  world.setBlock(at(10, Y, 10), gold);
  world.setBlock(at(12, Y, 11), dirt);
  stand(alice, 10, Y, 12); // two blocks "south" of the corner
  assert.match(say(alice, "/copy"), /6 blocks copied/);
  stand(alice, 60, Y, 60);
  assert.match(say(alice, "/paste"), /Pasted: 2 blocks changed/, "only the two solid blocks differ from the air that was there");
  assert.strictEqual(stateAt(60, Y, 58), gold, "the paste keeps the place relative to the player: the corner is 2 north");
  assert.strictEqual(stateAt(62, Y, 59), dirt);
  world.setBlock(at(61, Y, 58), stone);
  assert.match(say(alice, "/paste -a"), /Pasted: 0 blocks changed/, "-a leaves air out, so the stone is not erased");
  assert.strictEqual(stateAt(61, Y, 58), stone);
  assert.match(say(alice, "/paste"), /Pasted: 1 block changed/);
  assert.strictEqual(stateAt(61, Y, 58), air);

  stand(alice, 10, Y, 10);
  assert.match(say(alice, "/move 5 e"), /Moved: .* changed/);
  assert.strictEqual(stateAt(10, Y, 10), air, "the old place is cleared");
  assert.strictEqual(stateAt(15, Y, 10), gold, "and the blocks are 5 east");
  assert.strictEqual(stateAt(17, Y, 11), dirt);
  assert.match(say(alice, "/undo"), /Undid 1 edit/);
  assert.strictEqual(stateAt(10, Y, 10), gold, "undo puts everything back");
  assert.strictEqual(stateAt(15, Y, 10), air);

  // The selection is still (10..12, Y, 10..11): stack it twice to the south.
  assert.match(say(alice, "/stack 2 s"), /Stacked/);
  assert.strictEqual(stateAt(10, Y, 12), gold);
  assert.strictEqual(stateAt(10, Y, 14), gold);
  assert.strictEqual(stateAt(12, Y, 15), dirt);
  assert.match(say(alice, "/undo"), /Undid 1 edit/);
  assert.match(say(alice, "/paste"), /Pasted/, "stack and move do not touch the clipboard");
  assert.match(say(alice, "/clearclipboard"), /cleared/);
  assert.match(say(alice, "/paste"), /clipboard is empty/);
  console.log("ok copy, paste, move and stack");

  // ---------------------------------------------------------------- cut
  stand(alice, 10, Y, 10);
  assert.match(say(alice, "/cut"), /copied to the clipboard/);
  assert.strictEqual(stateAt(10, Y, 10), air);
  assert.match(say(alice, "/paste"), /Pasted: 2 blocks changed/);
  assert.strictEqual(stateAt(10, Y, 10), gold);
  console.log("ok cut");

  // ---------------------------------------------------------------- expand, contract, shift
  assert.match(say(alice, "/expand 2 up"), /3 x 3 x 2|Selection is now 3, 3, 2/);
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(10, Y, 10), max: at(12, Y + 2, 11) });
  say(alice, "/contract 1 up");
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(10, Y, 10), max: at(12, Y + 1, 11) });
  say(alice, "/shift 3 e");
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(13, Y, 10), max: at(15, Y + 1, 11) });
  say(alice, "/expand vert");
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(13, 0, 10), max: at(15, 255, 11) });
  assert.match(say(alice, "/contract 999 e"), /disappear/);
  say(alice, "/desel");
  assert.strictEqual(selectionOf("Alice"), undefined);
  console.log("ok expand, contract, shift and desel");

  // ---------------------------------------------------------------- the block limit
  stand(alice, 0, 0, 0);
  say(alice, "/pos1");
  stand(alice, 600, 255, 600);
  say(alice, "/pos2");
  assert.match(say(alice, "/set stone"), new RegExp(`limit is ${MAX_BLOCKS}`));
  assert.strictEqual(stateAt(300, 100, 300), air, "nothing was changed, and no chunk was needed");
  console.log("ok the block limit");

  // ---------------------------------------------------------------- looking at a block
  world.setBlock(at(80, Y, 80), stone);
  stand(alice, 80, Y - 4, 70, 0, 0); // looks south, along +z, at the height of the eyes: y + 1.62
  world.setBlock(at(80, Y - 3, 80), gold);
  assert.match(say(alice, "/hpos1"), /First position set to \(80, 147, 80\)/);
  stand(alice, 500, Y + 20, 500, 0, -90);
  assert.match(say(alice, "/hpos2"), /no block in sight/);
  console.log("ok hpos");

  // ---------------------------------------------------------------- the wand
  say(alice, "/desel");
  assert.strictEqual(alice.player.give === undefined, false);
  assert.match(say(alice, "/wand"), /wooden axe/);
  const held = alice.player.inventory.get(36);
  assert.ok(held, "the axe is in the first hotbar slot");
  alice.player.heldSlot = 0;
  world.setBlock(at(30, Y, 30), stone);
  world.setBlock(at(32, Y, 30), stone);
  alice.sent.length = 0;
  dig(alice, at(30, Y, 30));
  assert.match(lastMessage(alice), /First position set to \(30, 150, 30\)/);
  assert.strictEqual(stateAt(30, Y, 30), stone, "the axe does not break the block, even in creative mode");
  rightClick(alice, at(32, Y, 30));
  assert.match(lastMessage(alice), /Second position set to \(32, 150, 30\) \(3 blocks\)/);
  assert.deepStrictEqual(selectionOf("Alice"), { min: at(30, Y, 30), max: at(32, Y, 30) });
  // Survival digging: a click starts it, and the end of the dig must not break it either.
  alice.player.gameMode = GameMode.Survival;
  dig(alice, at(30, Y, 30), 0);
  dig(alice, at(30, Y, 30), 2);
  assert.strictEqual(stateAt(30, Y, 30), stone, "the end of a dig that started with the axe does not break the block");
  alice.player.gameMode = GameMode.Creative;
  // Another item breaks as usual.
  alice.player.setInventorySlot(36, null);
  dig(alice, at(30, Y, 30));
  assert.strictEqual(stateAt(30, Y, 30), air, "without the axe, a block breaks");
  // Someone who is not an operator gets no wand.
  bob.player.give("wooden_axe", 1);
  bob.player.gameMode = GameMode.Creative;
  world.setBlock(at(34, Y, 30), stone);
  dig(bob, at(34, Y, 30));
  assert.strictEqual(stateAt(34, Y, 30), air, "for others the axe is just an axe");
  assert.strictEqual(selectionOf("Bob"), undefined);
  console.log("ok the wand");

  // ---------------------------------------------------------------- the event itself
  {
    const seen: string[] = [];
    server.plugins.events.on("check", "playerInteract", (e) => seen.push(`${e.click} ${e.item ?? "-"} ${e.face}`));
    dig(alice, at(5, Y, 5));
    alice.player.give("stone", 1);
    rightClick(alice, at(5, Y, 5));
    rightClick(alice, at(5, Y, 5), 1);
    assert.deepStrictEqual(seen, ["left - 1", "right stone 1"], "left and right click, the item in hand, and only the main hand");
    server.plugins.events.removeAll("check");
    console.log("ok playerInteract");
  }

  // ---------------------------------------------------------------- leaving forgets
  assert.ok(selectionOf("Alice"), "the selection is still there while she is online");
  server.onConnectionClosed(alice.conn);
  assert.strictEqual(selectionOf("Alice"), undefined, "when a player leaves, their selection, clipboard and undo list are forgotten");
  console.log("ok leaving the server");
  console.log("ALL WORLDEDIT CHECKS PASS");
}

main()
  .catch((err) => {
    console.error("WORLDEDIT CHECK FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(os.tmpdir());
  });
