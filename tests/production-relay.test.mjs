import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRelay } from "../server/app.mjs";
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
