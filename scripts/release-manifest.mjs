import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  signedManifest,
  sha256,
  validateManifest,
} from "../updates/security.mjs";
import config from "../release/config.json" with { type: "json" };
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (a, v, i, list) =>
        i % 2 === 0 ? [...a, [v.replace(/^--/, ""), list[i + 1]]] : a,
      [],
    ),
);
const kind = args.kind || "firmware",
  version = config.version,
  tag = process.env.RELEASE_TAG || `v${version}`;
if (tag !== `v${version}`)
  throw new Error("Release tag must equal release/config.json version");
if (!args.binary || !args.url || !args.output)
  throw new Error("--binary --url --output required");
const bytes = await readFile(args.binary);
const publishedAt =
  process.env.RELEASE_PUBLISHED_AT || new Date().toISOString();
const payload = {
  schema: 1,
  kind,
  channel: "stable",
  version,
  sequence: Date.parse(publishedAt),
  hardware: kind === "firmware" ? config.hardware : "windows-x64",
  buildId: process.env.GITHUB_SHA || "local-release-build",
  size: bytes.length,
  sha256: sha256(bytes),
  url: args.url,
  publishedAt,
  compatibility:
    kind === "firmware"
      ? {
          partitionLayout: config.partitionLayout,
          dataSchema: config.dataSchema,
          idf: "6.0.3",
          initialBootloaderRollback: true,
        }
      : { protocol: 1, nodeMajor: 24 },
};
validateManifest(payload, { kind, currentVersion: "0.0.0" });
const key = await readFile(
  process.env.SW_SIGNING_KEY_PATH || ".secrets/release.pem",
  "utf8",
);
await mkdir("release-output", { recursive: true });
await writeFile(
  args.output,
  JSON.stringify(signedManifest(payload, key), null, 2),
);
console.log(`Signed ${kind} manifest ${version}; ${bytes.length} bytes`);
