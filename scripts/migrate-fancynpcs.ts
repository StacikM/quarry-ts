import fs from 'node:fs';
import path from 'node:path';
import { migrateFancyNpcs } from '../src/migrate/fancynpcs';
import { writeFileAtomic } from '../src/util/atomicWrite';
const args=process.argv.slice(2);
if(args.length!==1 && !(args.length===3&&args[1]==='--out')) {
  console.error('Usage: npx tsx scripts/migrate-fancynpcs.ts <path-to-npcs.yml> [--out plugins-data/npcs.json]'); process.exitCode=1;
} else {
  try {
    const source=path.resolve(args[0]), out=path.resolve(args[2]??'plugins-data/npcs.json');
    if(source===out) throw Error('Input and output must differ');
    if(fs.statSync(source).size>4*1024*1024) throw Error('YAML file exceeds 4 MiB');
    const {data,report}=migrateFancyNpcs(fs.readFileSync(source,'utf8'));
    if(fs.existsSync(out)) throw Error('Output already exists; choose a new --out path and compare before replacing it');
    fs.mkdirSync(path.dirname(out),{recursive:true}); writeFileAtomic(out,JSON.stringify(data,null,2)+'\n');
    console.log(`Migrated ${report.migrated}; skipped ${report.skipped.length}.`);
    for(const line of report.skipped) console.log(`SKIPPED: ${line}`);
    for(const line of report.unsupported) console.log(`UNSUPPORTED: ${line}`);
    for(const line of report.warnings) console.log(`NOTE: ${line}`);
    console.log(`Wrote ${args[2]??'plugins-data/npcs.json'}. Review leftovers/unsupported actions before starting the NPC plugin.`);
  } catch(error) { console.error(String(error)); process.exitCode=1; }
}
