import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../release/config.json" with { type: "json" };
import { compareVersion, verifyManifest } from "../updates/security.mjs";

const components = {
  firmware: ["stopwatch-firmware.bin", "firmware-manifest.json"],
  miao: ["miao.pack", "miao-manifest.json"],
  bridge: ["stopwatch-bridge.mjs", "bridge-manifest.json"],
  portal: ["stopwatch-portal.tar.gz", "portal-manifest.json"],
};
const names = ["firmware-notices.tar.gz", "StopWatch-Windows.zip",
  ...Object.values(components).map(pair => pair[0]), ...Object.values(components).map(pair => pair[1])];

async function sha(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

export async function verifyReleaseDirectory(directory, { repository, tag, build, key, portalOrigin }) {
  if (tag !== `v${config.version}` || !/^[a-f0-9]{40}$/.test(build)) throw new Error("Invalid stable identity");
  const local = new Map();
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile() || !info.size) throw new Error(`Missing stable asset: ${name}`);
    local.set(name, { file, size: info.size, digest: `sha256:${await sha(file)}` });
  }
  let identity;
  for (const [kind, [asset, manifest]] of Object.entries(components)) {
    const item = local.get(asset);
    const signed = verifyManifest(JSON.parse(await readFile(local.get(manifest).file, "utf8")), key, { kind, portalOrigin });
    if (signed.version !== config.version || signed.buildId !== build ||
        signed.url !== `https://github.com/${repository}/releases/download/${tag}/${asset}` ||
        item.size !== signed.size || item.digest !== `sha256:${signed.sha256}`)
      throw new Error(`Stable ${kind} package does not match its manifest`);
    const releaseIdentity = `${signed.sequence}/${signed.publishedAt}`;
    if (identity && identity !== releaseIdentity) throw new Error("Mixed stable release identities");
    identity = releaseIdentity;
  }
  return local;
}

async function publish(local, { repository, tag, build, token }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Missing publisher identity");
  const api = `https://api.github.com/repos/${repository}/releases`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28" };
  async function call(url, init, missing = false) {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Release API failed (${response.status})`);
    return response.json();
  }
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const gitApi = `https://api.github.com/repos/${repository}/git`;
  async function assertTag() {
    const { object } = await call(`${gitApi}/ref/tags/${tag}`);
    if (object?.type !== "tag" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Stable tag changed");
    const annotation = await call(`${gitApi}/tags/${object.sha}`);
    if (annotation.object?.type !== "commit" || annotation.object.sha !== build) throw new Error("Stable tag changed");
  }
  await assertTag();
  const latest = await call(`${api}/latest`, undefined, true);
  if (latest && compareVersion(latest.tag_name.replace(/^v/, ""), config.version) > 0)
    throw new Error("Refusing to move stable discovery backwards");
  // The authenticated list includes drafts, so a failed upload can be resumed.
  let release = (await call(`${api}?per_page=100`)).find(item => item.tag_name === tag);
  if (!release) release = await call(api, json("POST", { tag_name: tag, target_commitish: build,
    name: `StopWatch ${tag}`, draft: true, prerelease: false, generate_release_notes: true }));
  if (release.prerelease || release.tag_name !== tag) throw new Error("Stable draft identity mismatch");
  const assets = await call(`${api}/${release.id}/assets?per_page=100`);
  if (assets.some(asset => !local.has(asset.name))) throw new Error("Stable draft contains unexpected assets");
  for (const [name, item] of local) {
    const existing = assets.find(asset => asset.name === name);
    if (existing) {
      if (existing.state !== "uploaded" || existing.size !== item.size || existing.digest !== item.digest)
        throw new Error(`Existing ${name} differs. Preserve the published release and inspect the draft before retrying.`);
    } else {
      if (!release.draft) throw new Error("Published release is incomplete; use a new stable version");
      const uploaded = await call(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(item.size) },
        body: createReadStream(item.file), duplex: "half",
      });
      if (uploaded.digest !== item.digest || uploaded.size !== item.size || uploaded.state !== "uploaded")
        throw new Error(`Uploaded ${name} failed verification`);
    }
  }
  if (release.draft) {
    const uploaded = await call(`${api}/${release.id}/assets?per_page=100`);
    if (uploaded.length !== local.size || uploaded.some(asset => {
      const item = local.get(asset.name);
      return !item || asset.state !== "uploaded" || asset.size !== item.size || asset.digest !== item.digest;
    })) throw new Error("Stable draft is incomplete or changed during upload");
    await assertTag();
    await call(`${api}/${release.id}`, json("PATCH", { draft: false, make_latest: "true" }));
  }
  console.log(`Stable ${tag} is published with all four verified update channels`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.argv[2])
    throw new Error("Stable publication runs only from the release workflow");
  const { GITHUB_REPOSITORY: repository, RELEASE_TAG: tag, SW_BUILD_ID: build, GITHUB_TOKEN: token } = process.env;
  const key = await readFile(config.productionPublicKey);
  await publish(await verifyReleaseDirectory(process.argv[2], { repository, tag, build, key }), { repository, tag, build, token });
}
