/** Optional reference refresh: uses the locally installed vanilla client, never launches the game. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const minecraft = path.join(process.env.APPDATA, ".minecraft");
const jar = path.join(minecraft, "versions", "1.8.9", "1.8.9.jar");
const sha1 = "3870888a6c3d349d3771a3e9d16c9bf5e076b908";
assert.equal(crypto.createHash("sha1").update(fs.readFileSync(jar)).digest("hex"), sha1, "requires the unmodified Mojang 1.8.9 client jar");
const metadata = JSON.parse(fs.readFileSync(path.join(minecraft, "versions", "1.8.9", "1.8.9.json"), "utf8"));
const libraryPaths = metadata.libraries.map((entry) => entry.downloads?.artifact?.path)
  .filter(Boolean).map((file) => path.join(minecraft, "libraries", file)).filter((file) => fs.existsSync(file));
// Modern launchers replace the old logging jars without rewriting historical version JSON.
for (const artifact of ["log4j-api", "log4j-core"]) {
  const base = path.join(minecraft, "libraries", "org", "apache", "logging", "log4j", artifact);
  if (!libraryPaths.some((file) => path.basename(file).startsWith(artifact + "-")) && fs.existsSync(base)) {
    const versions = fs.readdirSync(base).sort().reverse();
    for (const version of versions) {
      const replacement = path.join(base, version, `${artifact}-${version}.jar`);
      if (fs.existsSync(replacement)) { libraryPaths.push(replacement); break; }
    }
  }
}
const javaRoot = path.join(process.env.ProgramFiles, "Java");
const javaHome = process.env.JAVA_HOME || fs.readdirSync(javaRoot).map((name) => path.join(javaRoot, name))
  .find((directory) => fs.existsSync(path.join(directory, "bin", "javac.exe")));
assert(javaHome, "a JDK is required to refresh the reference fixture");
const fixture = fs.mkdtempSync(path.join(root, ".vanilla-light-probe-"));
try {
  const javac = path.join(javaHome, "bin", "javac.exe");
  const java = path.join(javaHome, "bin", "java.exe");
  execFileSync(javac, ["-d", fixture, path.join(root, "scripts", "reference", "VanillaLightProbe.java")], { cwd: fixture, timeout: 30000, windowsHide: true });
  const classpath = [fixture, jar, ...libraryPaths].join(path.delimiter);
  const output = execFileSync(java, ["-cp", classpath, "audit.VanillaLightProbe"], { cwd: fixture, encoding: "utf8", timeout: 30000, windowsHide: true });
  const line = output.split(/\r?\n/).find((value) => value.startsWith("VANILLA_LIGHT_DATA="));
  assert(line, output);
  const blocks = JSON.parse(line.slice("VANILLA_LIGHT_DATA=".length));
  assert.equal(blocks.length, 198);
  const reference = { version: "1.8.9", clientSha1: sha1,
    source: `https://launcher.mojang.com/v1/objects/${sha1}/client.jar`, blocks };
  const destination = path.join(root, "docs", "reference", "vanilla-1.8.9-light.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(reference, null, 2) + "\n");
  console.log(`Extracted all ${blocks.length} block light values from verified vanilla client SHA-1 ${sha1}.`);
} finally {
  if (path.dirname(path.resolve(fixture)) !== root || !path.basename(fixture).startsWith(".vanilla-light-probe-")) throw new Error("Unsafe cleanup target");
  fs.rmSync(fixture, { recursive: true, force: true });
}
