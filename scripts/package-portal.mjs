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
await cp("release/config.json", `${root}/release-config.json`);
await cp("node_modules", `${root}/node_modules`, { recursive: true });
await writeFile(
  `${root}/delivery.json`,
  JSON.stringify({
    schema: 1,
    version: config.version,
    origin: config.productionOrigin,
    containsPrivateData: false,
    deployEnabled: false,
  }),
);
console.log(
  "Production portal artifact prepared. No SSH, VPS or DNS operation performed.",
);
