import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRelay } from "../server/app.mjs";
import { deviceHardware } from "../server/device-sync.mjs";
import http from "node:http";
const localFetch = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method || "GET", headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(",") : v,
                ]),
              ),
            }),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
test("production profile requires TLS origin, purpose-bound pairing, Secure sessions and explicit execution enablement", async () => {
  await assert.rejects(createRelay({ mode: "production" }), /HTTPS/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-prod-relay-"));
  const origin = "https://console.example.invalid";
  const relay = await createRelay({
    directory,
    port: 0,
    mode: "production",
    publicOrigin: origin,
  });
  const headers = {
    Host: "console.example.invalid",
    "X-Forwarded-Proto": "https",
    Origin: origin,
    "Content-Type": "application/json",
  };
  const call = (route, data, cookie) =>
    localFetch(`${relay.url}/api/${route}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const code = relay.store.ticket().code;
    const pair = await call("pair", { code });
    assert.equal(pair.status, 200);
    assert.match(pair.headers.get("set-cookie"), /Secure/);
    assert.match(pair.headers.get("set-cookie"), /Max-Age=2592000/);
    const cookie = pair.headers.get("set-cookie").split(";")[0];
    const ticket = await (await call("bridge/tickets", {}, cookie)).json();
    assert.equal((await call("pair", { code: ticket.code })).status, 401);
    const enrollment = await call("bridge/enroll", { code: ticket.code });
    assert.equal(enrollment.status, 200);
    const enrolled = await enrollment.json();
    assert.equal(relay.store.session(enrolled.token).role, "bridge");
    assert.equal(
      (await call("bridge/enroll", { code: ticket.code })).status,
      401,
    );
    assert.equal(
      (
        await call(
          "commands",
          { action: "start", id: "prod-task-123", text: "must not execute" },
          cookie,
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await localFetch(`${relay.url}/api/state`, {
          headers: { ...headers, Cookie: `sw_session=${enrolled.token}` },
        })
      ).status,
      401,
    );
    const missingProxy = await localFetch(`${relay.url}/api/health`, {
      headers: { Host: "console.example.invalid" },
    });
    assert.equal(missingProxy.status, 403);
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(relay.url.replace("http", "ws") + "/bridge", {
        headers: {
          ...headers,
          Authorization: `Bearer ${relay.bridgeToken}`,
          "X-StopWatch-Mode": "mock",
        },
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
    assert.equal(closed, 401);
    const revoked = await localFetch(`${relay.url}/api/bridge/revoke-self`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${enrolled.token}` },
    });
    assert.equal(revoked.status, 200);
    assert.equal(relay.store.session(enrolled.token), undefined);
  } finally {
    await relay.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("device sync delivers uploaded RGB565 and prevents device credentials from controlling Codex", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-device-relay-"));
  const origin = "https://console.example.invalid";
  const relay = await createRelay({ directory, port: 0, mode: "production", publicOrigin: origin });
  const call = (route, { method = "GET", headers = {}, body } = {}) => localFetch(`${relay.url}/api/${route}`, {
    method,
    headers: { Host: "console.example.invalid", "X-Forwarded-Proto": "https", ...headers },
    body,
  });
  const post = (route, value, headers = {}) => call(route, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
  try {
    const pair = await post("pair", { code: relay.store.ticket().code });
    const operator = { Cookie: pair.headers.get("set-cookie").split(";")[0] };
    const ticket = await (await post("device/tickets", {}, operator)).json();
    assert.equal((await post("pair", { code: ticket.code })).status, 401);
    const enrolled = await post("device/enroll", { code: ticket.code, hardware: deviceHardware });
    assert.equal(enrolled.status, 200);
    const { deviceId, token } = await enrolled.json();
    assert.equal(enrolled.headers.has("set-cookie"), false);
    assert.equal((await post("device/enroll", { code: ticket.code, hardware: deviceHardware })).status, 401);
    const device = { Authorization: `Bearer ${token}` };
    assert.equal((await post("commands", { action: "start" }, { Cookie: `sw_session=${token}` })).status, 401);
    assert.equal((await call("device/sync", { headers: operator })).status, 401);
    const upload = await call("photos", { method: "POST", headers: { Origin: origin, ...operator }, body: await readFile("assets/photos/0.jpg") });
    assert.equal(upload.status, 201);
    const { id } = await upload.json();
    assert.equal((await post("settings", { defaultPhoto: id }, operator)).status, 200);
    const snapshot = await (await call("device/sync", { headers: device })).json();
    assert.equal(snapshot.cover.defaultPhoto, id);
    const image = await call(`device/photos/${id}`, { headers: device });
    assert.equal(image.status, 200);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.deepEqual(snapshot.photos, [{ id, size: 466 * 466 * 2, sha256: createHash("sha256").update(bytes).digest("hex") }]);
    assert.deepEqual(snapshot.codex, { online: false, task: null, quota: null });
    assert.equal((await (await call("state", { headers: operator })).json()).deviceOnline, true);
    const settings = await post("settings", { displayMode: "smart", sleepAfter: 0, eggPhoto: id, eggDate: "02-29", utcOffset: -300 }, operator);
    assert.equal(settings.status, 200);
    const hidden = await (await call("device/sync", { headers: device })).json();
    assert.equal(hidden.cover.defaultPhoto, "builtin-0");
    assert.deepEqual(hidden.display, { mode: "smart", sleepAfter: 0, utcOffset: -300, eggDate: "02-29", eggMessage: snapshot.display.eggMessage, eggPhoto: id });
    assert.equal((await call(`photos/${id}`, { method: "DELETE", headers: { Origin: origin, ...operator } })).status, 200);
    const deleted = await (await call("device/sync", { headers: device })).json();
    assert.deepEqual(deleted.photos, []);
    assert.equal(deleted.cover.defaultPhoto, "builtin-0");
    assert.equal(deleted.display.eggPhoto, null);
    assert.equal((await call(`device/photos/${id}`, { headers: device })).status, 404);
    assert.equal((await post("revoke", { id: deviceId }, operator)).status, 200);
    assert.equal((await call("device/sync", { headers: device })).status, 401);
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
