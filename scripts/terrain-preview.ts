/** Run: npx tsx scripts/terrain-preview.ts [seed=1337] [centerX=0] [centerZ=0] */
import { Chunk } from "../src/world/Chunk";
import { Block } from "../src/world/blocks";
import { NaturalGenerator } from "../src/world/terrain/NaturalGenerator";

const [seed = 1337, centerX = 0, centerZ = 0] = process.argv.slice(2).map(Number);
if (![seed, centerX, centerZ].every(Number.isFinite)) throw new Error("Arguments must be finite numbers");
const generator = new NaturalGenerator(seed);
const chunks = new Map<string, Chunk>();
function chunkAt(x: number, z: number): Chunk {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), key = `${cx},${cz}`;
  let chunk = chunks.get(key);
  if (!chunk) { chunk = new Chunk(cx, cz); generator.generate(chunk); chunks.set(key, chunk); }
  return chunk;
}
function blockAt(x: number, y: number, z: number): number {
  return chunkAt(x, z).getBlockId(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16);
}
const symbols: Record<number, string> = {
  [Block.Air]: " ", [Block.Stone]: "#", [Block.Grass]: "G", [Block.Dirt]: ".",
  [Block.Bedrock]: "X", [Block.Water]: "~", [Block.Lava]: "L", [Block.Sand]: ":",
  [Block.Gravel]: ";", [Block.Log]: "T", [Block.Leaves]: "*", [Block.Snow]: "s",
  [Block.CoalOre]: "c", [Block.IronOre]: "i", [Block.GoldOre]: "g",
  [Block.DiamondOre]: "D", [Block.RedstoneOre]: "r", [Block.LapisOre]: "l",
  [Block.TallGrass]: '"', [Block.DeadBush]: "d", [Block.Dandelion]: "f", [Block.Poppy]: "F",
  [Block.Cactus]: "C", [Block.SugarCane]: "|",
};
const biomeSymbols: Record<number, string> = { 0: "~", 1: ".", 2: "d", 3: "^", 4: "f", 7: "r", 12: "s", 16: ":" };
const startX = Math.floor(centerX) - 48, startZ = Math.floor(centerZ) - 24;
console.log(`Seed ${seed}; center ${centerX},${centerZ}. Top blocks, 96 x 48:`);
console.log('G grass, * leaves, T logs, ~ water, : sand, ; gravel, s snow, # stone, " tall grass, f/F flowers, d bush, C cactus, | cane');
for (let z = startZ; z < startZ + 48; z++) {
  let row = "";
  for (let x = startX; x < startX + 96; x++) {
    let y = 120;
    while (y > 0 && blockAt(x, y, z) === Block.Air) y--;
    row += symbols[blockAt(x, y, z)] ?? "?";
  }
  console.log(row);
}
console.log("Biome overview (each character = 16 blocks): ~ ocean, . plains, d desert, ^ mountains, f forest, r river, s snow, : beach");
for (let dz = -12; dz < 12; dz++) {
  let row = "";
  for (let dx = -24; dx < 24; dx++) row += biomeSymbols[generator.biomeAt(Math.floor(centerX) + dx * 16, Math.floor(centerZ) + dz * 16)] ?? "?";
  console.log(row);
}
console.log(`Vertical slice at z=${Math.floor(centerZ)}; X bedrock, L lava, c/i/g/D/r/l ores:`);
for (let y = 110; y >= 0; y--) {
  let row = "";
  for (let x = startX; x < startX + 96; x++) row += symbols[blockAt(x, y, Math.floor(centerZ))] ?? "?";
  console.log(`${String(y).padStart(3)} ${row}`);
}
