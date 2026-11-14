import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import config from "../release/config.json" with { type: "json" };
import { mockIdentity } from "../updates/mock-server.mjs";
import { sha256, signedManifest } from "../updates/security.mjs";
import { activePortalRelease, PortalUpdateManager } from "../updates/portal.mjs";
import { verifyReleaseDirectory } from "../scripts/publish-release.mjs";
import {releaseAssetUrl} from "../updates/release.mjs";

test("stable delivery rejects mixed assets and rolls an unhealthy portal back without replacing private data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stopwatch-delivery-"));
  let server;
  try {
    const identity = await mockIdentity(path.join(root, "tls"));
    const build = "a".repeat(40), tag = `v${config.version}`, repository = "lezebomb/stopwatch";
    const origin = "https://companion.example.invalid";
    const file = Buffer.from("fixture release archive");
    const common = {
      schema: 1, channel: "stable", version: config.version, sequence: 100,
      publishedAt: new Date().toISOString(), buildId: build, size: file.length, sha256: sha256(file),
    };
    const portal = { kind: "portal", hardware: "linux-x64", compatibility: { dataSchema: 1, nodeMajor: 24, origin } };
    const assets = path.join(root, "assets");
    await mkdir(assets);
    for (const [asset, kind, hardware, compatibility] of [
      ["stopwatch-firmware.bin", "firmware", config.hardware, { partitionLayout: config.partitionLayout, dataSchema: 1, idf: "6.0.3" }],
      ["miao.pack", "miao", config.hardware, { dataSchema: 1, encoding: "MIA1", layoutSha256: "b".repeat(64) }],
      ["stopwatch-bridge.mjs", "bridge", "windows-x64", { protocol: 1, nodeMajor: 24 }],
      ["stopwatch-portal.tar.gz", portal.kind, portal.hardware, portal.compatibility],
    ]) {
      await writeFile(path.join(assets, asset), file);
      await writeFile(path.join(assets, `${kind}-manifest.json`), JSON.stringify(signedManifest({
        ...common, kind, hardware, compatibility, url: releaseAssetUrl(config,repository,tag,asset),
      }, identity.privateKey)));
    }
    for (const name of ["StopWatch-Windows.zip", "firmware-notices.tar.gz"])
      await writeFile(path.join(assets, name), file);
    const releaseOptions = { repository, tag, build, key: identity.publicKey, portalOrigin: origin };
    assert.equal((await verifyReleaseDirectory(assets, releaseOptions)).size, 10);
    await writeFile(path.join(assets, "miao.pack"), Buffer.alloc(file.length));
    await assert.rejects(verifyReleaseDirectory(assets, releaseOptions), /Stable miao/);

    const versions = path.join(root, "versions");
    const old = { version: "0.1.0", build: "old-build", origin, containsPrivateData: false };
    const initial = path.join(versions, "initial");
    const data = path.join(root, "private-photo");
    await mkdir(initial, { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ release: "initial" }));
    await writeFile(path.join(initial, "delivery.json"), JSON.stringify(old));
    await writeFile(data, "private");
    let delivery = { ...old, version: "1.0.0", build };
    let sequence = 100, unhealthy = true;
    server = https.createServer({ key: identity.tlsKey, cert: identity.ca }, (req, res) => {
      if (req.url === "/portal.tar.gz") return res.end(file);
      res.end(JSON.stringify(signedManifest({ ...common, ...portal, sequence, version: delivery.version,
        url: `https://127.0.0.1:${server.address().port}/portal.tar.gz`,
      }, identity.privateKey)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const manager = new PortalUpdateManager(root, {
      publicKey: identity.publicKey, ca: identity.ca, origin,
      manifestUrl: `https://127.0.0.1:${server.address().port}/manifest`,
      extract: async (archive, dest) => {
        assert.deepEqual(await readFile(archive), file);
        await writeFile(path.join(dest, "delivery.json"), JSON.stringify(delivery));
      },
      check: async (dest, expected, scratch) => {
        assert.equal(expected.version, delivery.version);
        assert.equal(path.dirname(dest), path.dirname(scratch));
        assert.notEqual(scratch, data);
      },
      restart: async () => {},
      health: async expected => {
        const active = JSON.parse(await readFile(path.join(await activePortalRelease(root), "delivery.json"), "utf8"));
        assert.equal(active.version, expected.version);
        if (unhealthy && expected.version !== old.version) throw new Error("fixture health failed");
      },
    });
    await assert.rejects(manager.run(), /fixture health failed/);
    assert.equal(await manager.current(), initial);
    assert.equal((await manager.run()).state, "quarantined");
    sequence++;
    unhealthy = false;
    delivery = { ...delivery, version: "1.0.1" };
    assert.equal((await manager.run()).state, "activated");
    assert.equal((await manager.run()).state, "up-to-date");
    assert.equal(await readFile(data, "utf8"), "private");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
