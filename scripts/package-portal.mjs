import { mkdir, cp, writeFile, readFile } from "node:fs/promises";
import config from "../release/config.json" with { type: "json" };
if (
  !config.productionOrigin ||
  new URL(config.productionOrigin).protocol !== "https:"
)
  throw new Error("Production origin missing");
const root = "release-output/portal";
await mkdir(root, { recursive: true });
for (const file of ["server", "shared", "package.json", "package-lock.json"])
  await cp(file, `${root}/${file}`, { recursive: true });
await cp("production-dist", `${root}/dist`, { recursive: true });
await mkdir(`${root}/release`, { recursive: true });
await cp("release/config.json", `${root}/release/config.json`);
await cp("node_modules", `${root}/node_modules`, { recursive: true });
for (const directory of ["scripts", "updates", "release", "deploy"])
  await mkdir(`${root}/bootstrap/${directory}`, { recursive: true });
for (const file of ["scripts/portal-update.mjs", "scripts/portal-service.mjs", "updates/portal.mjs", "updates/security.mjs",
  "updates/download.mjs", "updates/atomic.mjs", "release/config.json", "deploy/stopwatch.service.example",
  "deploy/stopwatch-update.service.example", "deploy/stopwatch-update.timer.example", "deploy/production.env.example"])
  await cp(file, `${root}/bootstrap/${file}`);
await writeFile(
  `${root}/delivery.json`,
  JSON.stringify({
    schema: 1,
    version: config.version,
    build: process.env.SW_BUILD_ID || process.env.GITHUB_SHA || "local",
    origin: config.productionOrigin,
    containsPrivateData: false,
  }),
);
console.log(
  "Production portal artifact prepared. No SSH, VPS or DNS operation performed.",
);
