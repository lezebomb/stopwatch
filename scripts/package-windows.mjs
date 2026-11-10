import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import config from "../release/config.json" with { type: "json" };
const development = process.argv.includes("--development");
if (process.platform !== "win32")
  throw new Error("Windows runtime packaging must run on Windows");
if (!development) await access(config.productionPublicKey);
else await import("./update-dev-key.mjs");
const root = path.resolve("windows/package");
await mkdir(`${root}/runtime`, { recursive: true });
await mkdir(`${root}/app`, { recursive: true });
await mkdir(`${root}/setup`, { recursive: true });
const banner =
  "import {createRequire as __swCreateRequire} from 'node:module';const require=__swCreateRequire(import.meta.url);";
for (const [entry, output] of [
  ["bridge/desktop-entry.mjs", "bridge.mjs"],
  ["windows/supervisor.mjs", "supervisor.mjs"],
])
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: banner },
    outfile: `${root}/app/${output}`,
    minify: false,
  });
await cp(process.execPath, `${root}/runtime/node.exe`);
const licensePath = path.join(path.dirname(process.execPath), "LICENSE");
if (existsSync(licensePath)) await cp(licensePath, `${root}/runtime/LICENSE`);
else {
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Node distribution LICENSE unavailable");
  await writeFile(`${root}/runtime/LICENSE`, await response.text());
}
for (const file of [
  "Launch.vbs",
  "Settings.vbs",
  "Settings.ps1",
  "Decrypt-Credential.ps1",
])
  await cp(`windows/${file}`, `${root}/app/${file}`);
await cp("windows/Install.vbs", `${root}/Install-StopWatch.vbs`);
await cp(
  "windows/Install-StopWatch.ps1",
  `${root}/setup/Install-StopWatch.ps1`,
);
await cp(
  development ? ".data/update-dev-public.pem" : config.productionPublicKey,
  `${root}/release-public.pem`,
);
await cp("LICENSE", `${root}/LICENSE`);
await cp("THIRD_PARTY_NOTICES.md", `${root}/THIRD_PARTY_NOTICES.md`);
await cp("node_modules/ws/LICENSE", `${root}/app/ws-LICENSE.txt`);
await writeFile(
  `${root}/install-profile.json`,
  JSON.stringify({
    production: !development,
    version: config.version,
    origin: config.productionOrigin,
    updateManifestUrl: config.bridgeManifestUrl,
    runtime: process.version,
    scope: "CurrentUser",
  }),
);
console.log(
  `Packaged ${development ? "DEVELOPMENT (installation blocked)" : "production"} Windows companion at ${root}; no installation or startup registration performed.`,
);
