import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, access, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import config from "../release/config.json" with { type: "json" };
const development = process.argv.includes("--development");
const localInstallation = process.argv.includes("--local-install");
if (development && localInstallation) throw new Error("Choose development or local installation");
if (process.platform !== "win32")
  throw new Error("Windows runtime packaging must run on Windows");
if (!development && !localInstallation) await access(config.productionPublicKey);
else if (development) await import("./update-dev-key.mjs");
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
for (const file of ["Launch.vbs", "Settings.vbs"])
  await cp(`windows/${file}`, `${root}/app/${file}`);
await cp("windows/Install.vbs", `${root}/Install-StopWatch.vbs`);
// The VBS launchers use Windows PowerShell 5.1, which needs a BOM for UTF-8.
for (const [file, directory] of [
  ["Install-StopWatch.ps1", "setup"],
  ["Install-Core.ps1", "setup"],
  ["Settings.ps1", "app"],
  ["Decrypt-Credential.ps1", "app"],
]) {
  const source = await readFile(`windows/${file}`, "utf8");
  await writeFile(`${root}/${directory}/${file}`, "\uFEFF" + source.replace(/^\uFEFF/, ""));
}
if (localInstallation) await unlink(`${root}/release-public.pem`).catch(e => { if (e.code !== "ENOENT") throw e; });
else await cp(
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
    localInstallation,
    version: config.version,
    origin: config.productionOrigin,
    updateManifestUrl: localInstallation ? null : config.bridgeManifestUrl,
    runtime: process.version,
    scope: "CurrentUser",
  }),
);
console.log(
  `Packaged ${development ? "DEVELOPMENT (installation blocked)" : localInstallation ? "LOCAL AUTHORIZED (updates unconfigured)" : "production"} Windows companion at ${root}; no installation or startup registration performed.`,
);
