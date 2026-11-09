import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createRelay } from "../server/app.mjs";
import { connectBridge } from "../bridge/client.mjs";
import { WebSocket } from "ws";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(30);
  }
  throw new Error("Timed out waiting for expected state");
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stopwatch-test-"));
  const relay = await createRelay({ directory, port: 0 });
  const closers = [];
  t.after(async () => {
    for (const close of closers) close();
    await wait(180);
    await relay.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 150,
    });
  });
  const ticket = relay.store.ticket();
  const paired = await fetch(`${relay.url}/api/pair`, {
    method: "POST",
    headers: { Origin: relay.url, "Content-Type": "application/json" },
    body: JSON.stringify(ticket),
  });
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const api = async (route, data, method = "POST", auth = cookie) => {
    const res = await fetch(`${relay.url}/api/${route}`, {
      method: data === undefined ? "GET" : method,
      headers: {
        Cookie: auth,
        Origin: relay.url,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  };
  return { relay, directory, ticket, cookie, api, closers };
}
test("pairing is short-lived single-use; auth, CSRF, viewer permissions and revocation enforced", async (t) => {
  const { relay, ticket, cookie, api } = await fixture(t);
  assert.equal((await api("pair", ticket)).status, 401);
  assert.equal((await api("state", undefined, "GET", "bad")).status, 401);
  const expired = relay.store.ticket("operator", Date.now() - 130000);
  assert.equal((await api("pair", expired)).status, 401);
  const bad = await fetch(`${relay.url}/api/settings`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://evil.test" },
    body: "{}",
  });
  assert.equal(bad.status, 403);
  const view = relay.store.pair(relay.store.ticket("viewer").code);
  assert.equal(
    (
      await api(
        "settings",
        { brightness: 30 },
        "POST",
        `sw_session=${view.token}`,
      )
    ).status,
    403,
  );
  assert.equal((await api("settings", { brightness: 500 })).status, 400);
  relay.store.revoke(view.id);
  assert.equal(
    (await api("state", undefined, "GET", `sw_session=${view.token}`)).status,
    401,
  );
});
test("photo conversion, malformed images, quota, deletion and default fallback", async (t) => {
  const { relay, cookie, api } = await fixture(t);
  const jpg = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#5b8d7b" },
  })
    .jpeg()
    .toBuffer();
  const upload = () =>
    fetch(`${relay.url}/api/photos`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: relay.url,
        "X-Photo-Name": "test.jpg",
      },
      body: jpg,
    });
  let res = await upload();
  assert.equal(res.status, 201);
  const photo = await res.json();
  const raw = await fetch(`${relay.url}/api/photos/${photo.id}.rgb565`, {
    headers: { Cookie: cookie },
  });
  assert.equal((await raw.arrayBuffer()).byteLength, 434312);
  const image = await fetch(`${relay.url}/api/photos/${photo.id}.jpg`, {
    headers: { Cookie: cookie },
  });
  const info = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  assert.equal(info.width, 466);
  assert.equal(info.height, 466);
  assert.equal((await api("settings", { defaultPhoto: photo.id })).status, 200);
  const bad = await fetch(`${relay.url}/api/photos`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: relay.url },
    body: "not an image",
  });
  assert.equal(bad.status, 400);
  for (let i = 1; i < 12; i++) assert.equal((await upload()).status, 201);
  assert.equal((await upload()).status, 400);
  assert.equal((await api(`photos/${photo.id}`, {}, "DELETE")).status, 200);
  assert.equal((await api("state")).body.settings.defaultPhoto, "builtin-0");
});
test("events are deduplicated and replayed; bridge auth denied without key", async (t) => {
  const { relay, cookie } = await fixture(t);
  const id = randomUUID();
  relay.publish({ v: 1, id, type: "test", payload: { ok: true } });
  relay.publish({ v: 1, id, type: "test", payload: { ok: true } });
  assert.equal(relay.store.events().length, 1);
  const received = [];
  const ws = new WebSocket(
    relay.url.replace("http", "ws") + "/events?after=0",
    { headers: { Cookie: cookie, Origin: relay.url } },
  );
  ws.on("message", (raw) => received.push(JSON.parse(raw)));
  await until(() => received.some((e) => e.type === "event"));
  ws.close();
  const bad = new WebSocket(relay.url.replace("http", "ws") + "/bridge");
  let rejected = false;
  bad.on("error", () => {
    rejected = true;
  });
  await until(() => rejected);
  assert.equal(relay.store.events().length, 1);
});
test("full Mock task flow: queued command, dedup, approval, denial, steering, failure, interrupt, reconnect", async (t) => {
  const { relay, directory, api, closers } = await fixture(t);
  const start = {
    id: randomUUID(),
    action: "start",
    text: "执行测试并申请审批",
  };
  assert.equal((await api("commands", start)).status, 202);
  assert.equal((await api("commands", start)).body.duplicate, true);
  const bridge = connectBridge({
    url: relay.url.replace("http", "ws"),
    token: relay.bridgeToken,
    directory,
    delay: 70,
  });
  closers.push(() => bridge.close());
  await until(() =>
    relay.store.tasks().find((task) => task.state === "approval"),
  );
  let task = relay.store.tasks()[0];
  assert(task.approvalId);
  await api("commands", {
    id: randomUUID(),
    action: "approve",
    taskId: task.id,
    approvalId: task.approvalId,
    decision: "accept",
  });
  await until(() =>
    relay.store.tasks().find((task) => task.state === "completed"),
  );
  const completedCount = relay.store.events().length;
  bridge.disconnect();
  await until(() => relay.store.events().length > completedCount);
  assert.equal(relay.store.tasks().length, 1);
  await api("commands", {
    id: randomUUID(),
    action: "continue",
    taskId: task.id,
    text: "模拟失败",
  });
  await until(() => relay.store.tasks()[0].state === "working");
  await api("commands", {
    id: randomUUID(),
    action: "steer",
    taskId: task.id,
    text: "额外指令",
  });
  await until(() => relay.store.tasks()[0].state === "failed");
  await api("commands", {
    id: randomUUID(),
    action: "continue",
    taskId: task.id,
    text: "再申请审批",
  });
  await until(() => relay.store.tasks()[0].state === "approval");
  task = relay.store.tasks()[0];
  await api("commands", {
    id: randomUUID(),
    action: "approve",
    taskId: task.id,
    approvalId: task.approvalId,
    decision: "decline",
  });
  await until(() => relay.store.tasks()[0].state === "failed");
  await api("commands", {
    id: randomUUID(),
    action: "continue",
    taskId: task.id,
    text: "再试一次",
  });
  await until(() => relay.store.tasks()[0].state === "thinking");
  await api("commands", {
    id: randomUUID(),
    action: "interrupt",
    taskId: task.id,
  });
  await until(() => relay.store.tasks()[0].state === "interrupted");
  assert(relay.store.events().some((e) => e.type === "quota"));
});
