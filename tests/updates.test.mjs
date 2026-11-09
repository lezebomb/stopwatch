import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createMockUpdates } from "../updates/mock-server.mjs";
import {
  verifyManifest,
  signedManifest,
  sha256,
} from "../updates/security.mjs";
import { fetchEnvelope, downloadVerified } from "../updates/download.mjs";
import { BootSlots } from "../updates/atomic.mjs";
import { ResourceStore } from "../updates/resources.mjs";
import { updateDecision, retryDelay } from "../updates/policy.mjs";
let root, server;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sw-updates-test-"));
  server = await createMockUpdates({ directory: path.join(root, "server") });
});
after(async () => {
  await server?.close();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
test("signed HTTPS OTA stream switches spare slot; failed health boot rolls back; healthy commit preserves private data", async () => {
  const dir = path.join(root, "device");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "private.json"),
    JSON.stringify({
      photo: "gift.jpg",
      wifi: "saved",
      binding: "test-only",
      egg: "private message",
    }),
  );
  const original = await readFile(path.join(dir, "private.json"));
  const envelope = await fetchEnvelope(server.url + "/manifest.json", {
    ca: server.ca,
  });
  const m = verifyManifest(envelope, server.publicKey, {
    kind: "firmware",
    currentVersion: "0.2.0",
    allowLoopback: true,
  });
  const bin = path.join(dir, "candidate.bin");
  await downloadVerified(m, bin, { ca: server.ca });
  const slots = new BootSlots(path.join(dir, "flash"));
  assert.equal(await slots.stage(m, bin), "B");
  assert.equal((await slots.boot()).lastResult, "pending-health");
  assert.equal((await slots.boot()).lastResult, "rolled-back");
  assert.equal((await slots.state()).active, "A");
  await slots.stage(m, bin);
  await slots.boot();
  await assert.rejects(
    slots.confirm({ ui: true, storage: true, audio: false, networkTask: true }),
    /Health/,
  );
  await slots.confirm({
    ui: true,
    storage: true,
    audio: true,
    networkTask: true,
  });
  assert.equal((await slots.state()).valid, "B");
  assert.equal((await slots.state()).highestSequence, m.sequence);
  assert.deepEqual(await readFile(path.join(dir, "private.json")), original);
  assert.throws(
    () =>
      verifyManifest(envelope, server.publicKey, {
        kind: "firmware",
        currentVersion: "0.2.1",
        allowLoopback: true,
      }),
    /not newer/,
  );
});
test("signature tampering, incompatible layout, downgrade, HTTP, wrong size/hash and disconnect never activate", async () => {
  const envelope = await fetchEnvelope(server.url + "/manifest.json", {
    ca: server.ca,
  });
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64"));
  const changed = {
    ...envelope,
    payload: Buffer.from(
      JSON.stringify({ ...payload, version: "9.9.9" }),
    ).toString("base64"),
  };
  assert.throws(
    () =>
      verifyManifest(changed, server.publicKey, {
        kind: "firmware",
        allowLoopback: true,
      }),
    /signature/,
  );
  for (const edit of [
    {
      compatibility: { ...payload.compatibility, partitionLayout: "different" },
    },
    { url: "http://insecure.invalid/bin" },
    { hardware: "wrong-board" },
    { size: 0x400001 },
  ])
    assert.throws(() =>
      verifyManifest(
        signedManifest({ ...payload, ...edit }, server.privateKey),
        server.publicKey,
        { kind: "firmware", allowLoopback: true },
      ),
    );
  for (const behavior of ["corrupt", "disconnect", "truncated"]) {
    server.behavior(behavior);
    await assert.rejects(
      downloadVerified(payload, path.join(root, `bad-${behavior}.bin`), {
        ca: server.ca,
        timeout: 1500,
      }),
    );
    assert(!existsSync(path.join(root, `bad-${behavior}.bin`)));
  }
  server.behavior("normal");
  await assert.rejects(
    fetchEnvelope(server.url + "/manifest.json"),
    /self-signed|certificate/,
  );
});
test("power policy does not wake radios, defers busy/unstable/low-power and retries with bounded backoff", () => {
  const base = {
    now: 10000,
    connected: true,
    charging: true,
    battery: 70,
    stableFor: 61,
    idleFor: 31,
  };
  assert.equal(updateDecision(base), "install");
  assert.equal(updateDecision({ ...base, charging: false }), "battery-no-poll");
  assert.equal(
    updateDecision({ ...base, charging: false, reconnected: true }),
    "check-only",
  );
  assert.equal(updateDecision({ ...base, busy: true }), "busy");
  assert.equal(updateDecision({ ...base, stableFor: 5 }), "unstable");
  assert.equal(updateDecision({ ...base, battery: 10 }), "check-only");
  assert.equal(updateDecision({ ...base, lastCheck: 9999 }), "rate-limited");
  assert.equal(
    updateDecision({ ...base, lastCheck: 9999, nextAttempt: 9999 }),
    "install",
  );
  assert.equal(retryDelay(20), 21600);
});
test("resource pointer commit is atomic, validates namespace/capacity and preserves personal photos", async () => {
  const store = new ResourceStore(path.join(root, "resources"), {
    budget: 60000,
  });
  const m = server.manifest();
  const file = {
    name: "frame.rgb",
    url: m.url,
    size: m.size,
    sha256: m.sha256,
  };
  const manifest = {
    ...m,
    kind: "resources",
    namespace: "system",
    files: [file],
    size: file.size,
    sha256: sha256(Buffer.from(JSON.stringify([file]))),
    compatibility: { dataSchema: 1 },
  };
  const envelope = signedManifest(manifest, server.privateKey);
  await assert.rejects(
    store.apply(envelope, server.publicKey, {
      ca: server.ca,
      failpoint: "before-commit",
    }),
    /power loss/,
  );
  assert.equal((await store.active()).version, "0.0.0");
  await store.apply(envelope, server.publicKey, { ca: server.ca });
  assert.equal((await store.health()).ok, true);
  const bad = signedManifest(
    {
      ...manifest,
      version: "0.2.2",
      sequence: m.sequence + 1,
      namespace: "personal",
    },
    server.privateKey,
  );
  await assert.rejects(
    store.apply(bad, server.publicKey, { ca: server.ca }),
    /namespace/,
  );
  await writeFile(path.join(store.root, "objects", file.sha256), "corrupt");
  assert.deepEqual(await store.health(), { ok: false, restored: true });
  assert.equal((await store.active()).version, "0.0.0");
});
test("portable firmware C OTA policy and transaction adapter compile and execute", () => {
  const zig = path.resolve(
    `.tools/host/ziglang/${process.platform === "win32" ? "zig.exe" : "zig"}`,
  );
  assert(existsSync(zig), "Install documented Zig host dependency");
  mkdirSync("artifacts", { recursive: true });
  const executable = path.resolve(
    "artifacts/update-core-host" + (process.platform === "win32" ? ".exe" : ""),
  );
  execFileSync(
    zig,
    [
      "cc",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Ifirmware/companion",
      "firmware/companion/sw_update_core.c",
      "tests/update-core-host.c",
      "-o",
      executable,
    ],
    {
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: path.resolve(".tools/zig-cache"),
      },
      stdio: "pipe",
    },
  );
  assert.match(execFileSync(executable, [], { encoding: "utf8" }), /passed/);
});
