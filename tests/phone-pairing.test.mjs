import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store, digest } from "../server/store.mjs";
import { createPhonePairing, phoneProof, phoneRef } from "../server/phone-pairing.mjs";
import { createRelay } from "../server/app.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-phone-"));
  const store = new Store(directory);
  try {
    const token = store.pair(store.ticket("device").code, Date.now(), "device");
    await run(store, token, createPhonePairing(store));
  } finally { store.db.close(); await rm(directory, { recursive: true, force: true }); }
}
test("offline device proof creates a bounded photo manager; repeat pairing is read-only, nonce-bound and single use", () => fixture((store, device, phones) => {
  const ref = phoneRef(digest(device.token));
  const first = phones.begin(ref, "browser-1");
  const input = { challenge: first.challenge, code: "001234", proof: phoneProof(digest(device.token), first.challenge, "001234") };
  assert.throws(() => phones.complete(input, "another-browser"), /过期/);
  const paired = phones.complete(input, "browser-1");
  assert.equal(paired.role, "manager");
  assert.equal(store.session(paired.token).deviceId, device.id);
  assert.throws(() => phones.complete(input, "browser-1"), /已使用/);
  const second = phones.begin(ref, "browser-2");
  const viewer = phones.complete({ challenge: second.challenge, code: "654321", proof: phoneProof(digest(device.token), second.challenge, "654321") }, "browser-2");
  assert.equal(viewer.role, "viewer");
  assert.throws(() => phones.change(store.session(viewer.token), paired.id, "manager"), /管理手机/);
  assert.throws(() => phones.change(store.session(paired.token), viewer.id, "operator"), /只支持/);
  assert.throws(() => phones.change(store.session(paired.token), viewer.id, "codex-on", true), /原控制端/);
  phones.change(store.session(paired.token), viewer.id, "manager");
  assert.equal(store.session(viewer.token).role, "manager");
  phones.change(store.session(paired.token), viewer.id, "revoke");
  assert.equal(store.session(viewer.token), undefined);
  store.revoke(paired.id);
  const third = phones.begin(ref, "browser-3");
  assert.equal(phones.complete({ challenge: third.challenge, code: "112233", proof: phoneProof(digest(device.token), third.challenge, "112233") }, "browser-3").role, "viewer");
}));
test("bad code/proof attempts persist, expiry and device revocation invalidate browser sessions", () => fixture((store, device, phones) => {
  const ref = phoneRef(digest(device.token)), claim = phones.begin(ref, "browser");
  for (let n = 0; n < 5; n++) assert.throws(() => phones.complete({ challenge: claim.challenge, code: "123456", proof: n === 0 ? ["0".repeat(64)] : "0".repeat(64) }, "browser"), /无效/);
  assert.throws(() => phones.complete({ challenge: claim.challenge, code: "123456", proof: phoneProof(digest(device.token), claim.challenge, "123456") }, "browser"), /过期/);
  const expired = phones.begin(ref, "browser");
  assert.throws(() => phones.complete({ challenge: expired.challenge }, "browser", expired.expires), /过期/);
  const active = phones.begin(ref, "browser"), linked = phones.complete({ challenge: active.challenge, code: "123456", proof: phoneProof(digest(device.token), active.challenge, "123456") }, "browser");
  store.revoke(device.id);
  assert.equal(store.session(linked.token), undefined);
  assert.throws(() => phones.begin(ref, "browser"), /尚未准备/);
}));

function request(url, headers, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: data === undefined ? "GET" : "POST", headers }, res => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, cookies: res.headers["set-cookie"] || [], body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
test("one device proof sets a secure console session without a second login, photo access never grants execution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-phone-http-"));
  const relay = await createRelay({ directory, port: 0, mode: "production", publicOrigin: "https://phone.example", allowExecution: true });
  const headers = { Host: "phone.example", Origin: "https://phone.example", "X-Forwarded-Proto": "https", "Content-Type": "application/json" };
  const call = (route, data, cookie) => request(`${relay.url}/api/${route}`, { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, data);
  try {
    const device = relay.store.pair(relay.store.ticket("device").code), ref = phoneRef(digest(device.token));
    const claim = await call("phone/challenge", { deviceRef: ref });
    assert.equal(claim.status, 200);
    const result = await call("phone/complete", { challenge: claim.body.challenge, code: "123456", proof: phoneProof(digest(device.token), claim.body.challenge, "123456") }, claim.cookies[0].split(";")[0]);
    assert.equal(result.status, 200); assert.equal(result.body.role, "manager");
    assert.match(result.cookies[0], /HttpOnly; SameSite=Strict/); assert.match(result.cookies[0], /Secure/);
    const cookie = result.cookies[0].split(";")[0];
    assert.equal((await call(`phone/session?device=${ref}`, undefined, cookie)).body.paired, true);
    const state = await call("state", undefined, cookie);
    assert.equal(state.status, 200); assert.equal(state.body.deviceOnline, false);
    assert.equal(state.body.executionEnabled, false); assert.equal(state.body.session.phone, true);
    assert.equal((await call("settings", { brightness: 25 }, cookie)).status, 200);
    assert.equal((await call("commands", { action: "start", id: "ungranted-task", text: "write" }, cookie)).status, 403);
    assert.equal((await call("bridge/tickets", {}, cookie)).status, 403);
    assert.equal((await call("device/permissions", { id: device.id, enabled: true }, cookie)).status, 403);
    const operator = relay.store.pair(relay.store.ticket("operator").code), operatorCookie = `sw_session=${operator.token}`;
    assert.equal((await call("phone/access", { id: result.body.id, role: "codex-on" }, operatorCookie)).status, 403);
    assert.equal((await call("phone/access", { id: result.body.id, role: "codex-on", reviewed: true }, operatorCookie)).status, 200);
    assert.equal((await call("state", undefined, cookie)).body.executionEnabled, true);
    const command = { action: "start", id: "delegated-fixture", text: "inspect fixture", sandbox: "read-only" };
    assert.equal((await call("commands", command, cookie)).status, 202); // Queue only, no bridge or real execution.
    assert.equal((await call("tickets", { role: "operator" }, cookie)).status, 403);
    assert.equal((await call("phone/access", { id: result.body.id, role: "codex-off" }, operatorCookie)).status, 200);
    assert.equal(relay.store.pending().some(c => c.id === command.id), false);
    assert.equal(relay.store.receipt(command.id).stage, "uncertain");
    assert.equal((await call("commands", { ...command, id: "revoked-fixture" }, cookie)).status, 403);
    relay.store.revoke(result.body.id);
    assert.equal((await call("state", undefined, cookie)).status, 401);
  } finally { await relay.close(); await rm(directory, { recursive: true, force: true }); }
});
