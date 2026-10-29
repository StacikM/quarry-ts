# Minecraft 1.8.9 / protocol 47 audit

Audited on 2026-10-29. Scope: every declared packet ID, outgoing packet builder, implemented incoming field sequence, packed positions, metadata, and Overworld chunk serialization. No production protocol/network/chunk files were edited for this audit.

## Sources and independent checks

- [PrismarineJS protocol-47 schema](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.8/protocol.json), installed as development dependency `minecraft-data@3.109.0`. Selecting `1.8.9` resolves to its shared `1.8.8` data with protocol number **47**, asserted by the check.
- [PrismarineJS serializer/decoder](https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/src/transforms/serializer.js), pinned as development dependency `minecraft-protocol@1.68.0`. `scripts/protocol-check.ts` passes our outgoing bytes to that decoder and requires complete consumption, including the packet ID. Incoming fixtures are built by its independent encoder and read by our reader.
- [Independent 1.8 chunk-column implementation](https://github.com/PrismarineJS/prismarine-chunk/blob/master/src/pc/1.8/chunk.js) and [section implementation](https://github.com/PrismarineJS/prismarine-chunk/blob/master/src/pc/1.8/section.js). Used to check raw chunk-buffer layout; the protocol schema alone treats that buffer as opaque bytes.

Run `npx tsx scripts/protocol-check.ts`. These packages are development tools; server source does not import them. This is independent implementation verification, not a claim that a graphical vanilla client has joined.

Notation below: VI = signed 32-bit VarInt; I/U = signed/unsigned integer with bit width; F = IEEE float with bit width; S = VarInt UTF-8 byte length plus text; B = one-byte boolean; A = one-byte rotation; P = packed position; UUID = 16 raw bytes. Ordered comma-separated fields appear in wire order. Unless noted, our builder sends exactly the listed order/types and the independent decoder confirms it.

## Clientbound packets

| State / ID / builder | Specification | Our bytes / verdict |
| --- | --- | --- |
| Status 00 `statusResponse` | S JSON | JSON-encoded response; PASS, including Unicode. |
| Status 01 `pong` | I64 payload | Signed bigint preserves all eight bytes; PASS for positive, zero and negative values. |
| Login 00 `loginDisconnect` | S JSON reason | Chat component JSON; PASS. |
| Login 02 `loginSuccess` | S UUID, S name | Dashed UUID text followed by username; PASS. |
| Play 00 `keepAlive` | VI ID | PASS, including negative and multibyte IDs. |
| Play 01 `joinGame` | I32 entity, U8 mode, I8 dimension, U8 difficulty, U8 player limit, S level type, B reduced debug | PASS. Sends Overworld, peaceful, `flat`, false. `flat` for natural terrain is a cosmetic choice, not a field-order failure. |
| Play 02 `chatMessage` | S JSON, I8 position | PASS; position 0. |
| Play 05 `spawnPosition` | P location | PASS, including signed field boundaries. |
| Play 08 `playerPositionAndLook` | F64 x/y/z, F32 yaw/pitch, I8 flags | PASS; flags 0 means absolute coordinates. No teleport-confirm ID exists in this version. |
| Play 0b `animation` | VI entity, U8 animation | PASS. |
| Play 0c `spawnPlayer` | VI entity, UUID, I32 x/y/z, A yaw/pitch, I16 held item, metadata | PASS. Fixed-point coordinates, zero held item, health entry and terminator decoded correctly. |
| Play 13 `destroyEntities` | VI count, VI IDs | PASS. |
| Play 18 `entityTeleport` | VI entity, I32 x/y/z, A yaw/pitch, B grounded | PASS. |
| Play 19 `entityHeadLook` | VI entity, A yaw | PASS. |
| Play 21 `chunkData` | I32 chunk x/z, B ground-up, U16 mask, VI byte count, raw data | PASS; includes biomes and Overworld skylight. Raw layout checked below. |
| Play 21 `unloadChunk` | Ground-up chunk with zero sections and empty data | Sends true, mask 0, byte count 0; field-level PASS. Actual vanilla unload behavior remains UNVERIFIED by a real client. |
| Play 23 `blockChange` | P location, VI state | PASS; state encodes ID and metadata. |
| Play 2b `changeGameMode` | U8 reason, F32 value | PASS; reason 3. |
| Play 38 `playerListAdd` | VI action/count, UUID, S name, VI properties, VI mode/ping, optional display name | PASS; action 0, zero properties, absent display name. |
| Play 38 `playerListUpdateGameMode` | Action 1, count, UUID, VI mode | PASS. |
| Play 38 `playerListRemove` | Action 4, count, UUIDs | PASS. |
| Play 40 `playDisconnect` | S JSON reason | PASS. |

The source schema calls rotations I8 in some packets while our writer uses U8. This has identical wire bits: 270 degrees is byte `c0`, decoded as -64 steps by the signed decoder. This is not a mismatch. Negative fixed-point positions use `floor(coordinate * 32)`, independently checked with fractional negative coordinates.

Spawn metadata is `66` hex (type 3, index 6), F32 health 20, then `7f`. The independent decoder returns a float entry for key 6 and consumes the terminator. Player-list entries are sent before Spawn Player in `MinecraftServer.addPlayer`; login success precedes the Play state transition. Ordering inspected in source; full vanilla rendering remains UNVERIFIED.

## Serverbound packets

| State / ID / handler | Specification | Our reads / verdict |
| --- | --- | --- |
| Handshake 00 | VI version, S host, U16 port, VI next state | Same sequence; PASS. Status/login transitions inspected. |
| Status 00 | No fields | Request consumes no fields; PASS. |
| Status 01 | I64 payload | Reads bigint and echoes it; PASS. |
| Login 00 | S name | Same; PASS. Username validation, protocol check and offline login inspected. |
| Play 00 keep-alive | VI ID | Same; PASS. |
| Play 01 chat | S message | Same; PASS. Sanitization is application policy after decoding. |
| Play 03 standing | B grounded | Same; PASS. |
| Play 04 position | F64 x/y/z, B grounded | Same; PASS. No obsolete stance/head-Y field is read. |
| Play 05 look | F32 yaw/pitch, B grounded | Same; PASS. |
| Play 06 position/look | F64 x/y/z, F32 yaw/pitch, B grounded | Same; PASS. |
| Play 07 digging | VI status, P location, I8 face | PASS after Claude's correction to `readVarInt()`. The original I8 mismatch was reproduced with a two-byte encoding of zero. |
| Play 08 placement | P clicked location, I8 face, slot, three I8 cursor coordinates | Location/face/slot prefix PASS. Our slot reader deliberately stops before NBT; handler ignores NBT and cursor fields. That is sufficient for current placement, but not a complete general slot decoder. Empty-hand -1 is tested. |
| Play 0a arm animation | No fields | Same; PASS. |

Every ID in `packetIds.ts` matches the independently installed schema. Unsupported packet types, online authentication, encryption and compression are outside implemented scope. Not sending Set Compression means the connection keeps ordinary uncompressed framing; this is a supported protocol choice.

## Chunk data and primitives

The independent chunk implementation places all included sections' state arrays first, then all block-light arrays, then all skylight arrays, then 256 biome bytes. Our output matches that organization, rather than interleaving the three arrays per section.

Each included section uses 8,192 state bytes, 2,048 block-light bytes and 2,048 Overworld skylight bytes. States are little-endian U16; block order is X fastest, then Z, then Y. The audit creates sparse sections 0, 1, 7 and 15, checks their mask/order and individual states/metadata, verifies light-array boundaries and low/even nibble order, and checks biome indexing. Expected total is `sectionCount * 12288 + 256`. No palettes or per-section compression belong in this version's raw payload. Light propagation quality is outside this byte-layout audit.

Packed positions use signed X26/Y12/Z26, from most significant to least significant bits. The audit checks outgoing decoding and independently encoded incoming values at negative and positive boundaries. UUID byte layout, big-endian numeric primitives, signed VarInts, UTF-8 byte lengths and outer length framing pass normal fixtures. The frame-length prefix includes the ID and payload, excluding itself.

## Findings and limits

1. **P2 — digging status uses the wrong reader**, `src/protocol/handlers/play.ts:141`: replace `readByte()` with `readVarInt()`. Reproduced with status 0 encoded as `80 00`; the independent schema decoder reports 0 while our handler performs no break. Normal vanilla encodings are one byte, so no ordinary-client disconnect was demonstrated.
2. **P2 — negative string length is accepted**, `src/network/PacketReader.ts:38`: reject a negative byte count before bounds checking and moving the cursor. The five-byte VarInt -1 returns an empty string instead of an exception and moves the internal offset backwards. This is an invalid-input guard issue, not an observed failure from normal client traffic.

Both findings were corrected by Claude and now pass their executable regressions. The fixture also follows the current `server.setBlock()` editing API. No malformed outgoing packet was found in the 29 independently decoded fixtures; 15 normal incoming fixtures pass too. Claude subsequently reported that the human joined with a real 1.8.9 client and terrain rendered correctly. This audit itself did not observe that session. Actual client-side chunk-unload behavior, skin authentication, survival mechanics, full NBT handling, lighting propagation, all invalid-frame defenses and ignored packet types remain **UNVERIFIED / outside scope** here.
