/** Run npx tsc first, then node scripts/terrain-benchmark.cjs. Uses only compiled code. */
const { performance } = require("node:perf_hooks");
const { Chunk } = require("../dist/world/Chunk");
const { NaturalGenerator } = require("../dist/world/terrain/NaturalGenerator");
const generator = new NaturalGenerator(1337);
function generate(i) {
  const chunk = new Chunk(i % 16 - 8, Math.floor(i / 16) - 8);
  generator.generate(chunk);
  return chunk;
}
for (let i = 0; i < 128; i++) generate(i).serialize();
let generationMs = 0, serializationMs = 0;
const count = 256, rounds = 3;
for (let round = 0; round < rounds; round++) {
  let start = performance.now();
  const chunks = Array.from({ length: count }, (_, i) => generate(i));
  generationMs += performance.now() - start;
  start = performance.now();
  for (const chunk of chunks) chunk.serialize();
  serializationMs += performance.now() - start;
}
console.log(JSON.stringify({ seed: 1337, chunks: count * rounds,
  generationMsPerChunk: generationMs / (count * rounds),
  serializationMsPerChunk: serializationMs / (count * rounds),
  totalMsPerChunk: (generationMs + serializationMs) / (count * rounds),
}, null, 2));
