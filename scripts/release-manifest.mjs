import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  signedManifest,
  sha256,
  validateManifest,
} from "../updates/security.mjs";
import config from "../release/config.json" with { type: "json" };
import {releaseAssetUrl,releaseComponents} from "../updates/release.mjs";
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
if (!args.binary || !args.output) throw new Error("--binary --output required");
args.url ||= releaseAssetUrl(config, process.env.GITHUB_REPOSITORY || "lezebomb/stopwatch", tag, releaseComponents[kind]?.[0]);
const bytes = await readFile(args.binary);
const publishedAt =
  process.env.RELEASE_PUBLISHED_AT || new Date().toISOString();
const [major, minor, patch] = version.split(".").map(Number);
// Ordered by stable version even if a tag is built again on a later day.
const sequence = 1_000_000_000_000_000 + major * 10_000_000_000 + minor * 100_000 + patch;
const resource = kind === "miao" ? JSON.parse(await readFile(".deps/miao-pack/manifest.json", "utf8")) : null;
if (!['firmware', 'bridge', 'portal', 'miao'].includes(kind)) throw new Error("Unknown stable artifact");
if (resource && (resource.bytes !== bytes.length || resource.sha256 !== sha256(bytes)))
  throw new Error("Generated Miao manifest does not match the staged pack");
const payload = {
  schema: 1,
  kind,
  channel: "stable",
  version,
  sequence,
  hardware: kind === "bridge" ? "windows-x64" : kind === "portal" ? "linux-x64" : config.hardware,
  buildId: process.env.SW_BUILD_ID || process.env.GITHUB_SHA || "local-release-build",
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
      : kind === "miao"
        ? { dataSchema: config.dataSchema, encoding: "MIA1", layoutSha256: resource.layoutSha256 }
        : kind === "portal"
          ? { dataSchema: config.dataSchema, nodeMajor: 24, origin: config.productionOrigin }
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
