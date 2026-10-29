/** Compare every 1.8 block with a fixture extracted from the verified Mojang client. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import minecraftData from "minecraft-data";
import { lightOpacity, lightEmission } from "../src/world/lightData";

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/reference/vanilla-1.8.9-light.json"), "utf8"));
const data = minecraftData("1.8.9");
assert.equal(reference.clientSha1, "3870888a6c3d349d3771a3e9d16c9bf5e076b908");
assert.equal(reference.blocks.length, 198);
let dataDisagreements = 0;
for (const block of reference.blocks) {
  assert.equal(lightOpacity(block.id), block.opacity, `opacity for ${block.id} ${data.blocks[block.id].name}`);
  assert.equal(lightEmission(block.id), block.emission, `emission for ${block.id} ${data.blocks[block.id].name}`);
  const source = data.blocks[block.id];
  if ((source.filterLight === 15 ? 255 : source.filterLight) !== block.opacity || source.emitLight !== block.emission) dataDisagreements++;
}
assert.equal(lightOpacity(198), 255, "end rods are not present in 1.8.9");
assert.equal(lightEmission(198), 0);
console.log(`Light registry: all 198 ids match vanilla 1.8.9; ${dataDisagreements} legacy minecraft-data disagreements recorded separately.`);
