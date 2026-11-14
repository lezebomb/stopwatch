import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createMuseEgress, museDestination } from "../server/muse-egress.mjs";

const token = "d".repeat(32), operator = "o".repeat(32);
async function fixture(t, options = {}) {
  let authorized = true, connects = 0;
  const echo = net.createServer(options.handleSocket || (socket => socket.pipe(socket)));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const gateway = createMuseEgress({ enabled: true,
    session: value => value === token && authorized ? { id: "device", role: "device" }
      : value === operator ? { id: "operator", role: "operator" } : null,
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    connect: config => {
      assert.equal(config.host, "1.1.1.1"); assert.equal(config.port, 443);
      connects++; return net.createConnection({ host: "127.0.0.1", port: echo.address().port });
    }, checkInterval: 25, ...options });
  const server = http.createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => {
    if (!gateway.upgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    gateway.close();
    await Promise.all([new Promise(resolve => server.close(resolve)),
      new Promise(resolve => echo.close(resolve))]);
  });
  async function open(host = "api.muse.ai", credential = token, query = "") {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/device/muse-tunnel?host=${encodeURIComponent(host)}${query}`,
        { headers: credential ? { Authorization: `Bearer ${credential}` } : {}, handshakeTimeout: 2000 });
      ws.on("error", reject);
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => {
        res.resume(); resolve(res.statusCode); ws.terminate();
      });
    });
  }
  return { open, gateway, revoke: () => { authorized = false; }, get connects() { return connects; } };
}

test("Muse egress accepts only official API/VM DNS names and enrolled devices", async t => {
  assert(museDestination("api.muse.ai")); assert(museDestination("a-b.region.metaaivm.com"));
  for (const name of ["muse.ai", "other.muse.ai", "api.muse.ai.evil.test", "metaaivm.com", "127.0.0.1", "a..metaaivm.com", "-a.metaaivm.com"])
    assert.equal(museDestination(name), false);
  const f = await fixture(t);
  assert.equal(await f.open("api.muse.ai", null), 401);
  assert.equal(await f.open("api.muse.ai", operator), 401);
  assert.equal(await f.open("localhost"), 400);
  assert.equal(await f.open("api.muse.ai", token, "&port=22"), 400);
  assert.equal(f.connects, 0);
});

test("Muse egress pins public DNS answers and blocks loopback/private/mixed answers", async t => {
  const f = await fixture(t, { resolve: async () => [{ address: "1.1.1.1", family: 4 }, { address: "169.254.169.254", family: 4 }] });
  assert.equal(await f.open(), 403); assert.equal(f.connects, 0);
});

test("Muse egress preserves opaque binary streams and closes revoked device connections", async t => {
  const f = await fixture(t), ws = await f.open("vm-1.metaaivm.com");
  const input = randomBytes(16384); input[0] = 0x16; input[1] = 3;
  const received = once(ws, "message"); ws.send(input);
  assert.deepEqual(Buffer.from((await received)[0]), input);
  const closed = once(ws, "close"); f.revoke(); await closed;
  assert.equal(f.gateway.active, 0); assert.equal(await f.open(), 401);
});

test("Muse egress bounds per-device sockets and stays disabled unless explicitly enabled", async t => {
  const f = await fixture(t), clients = [];
  for (let n = 0; n < 6; n++) clients.push(await f.open());
  assert.equal(await f.open(), 429); assert.equal(f.connects, 6);
  const closed = once(clients[0], "close"); clients[0].close(); await closed;
  const replacement = await f.open(); assert(replacement instanceof WebSocket);
  const disabled = await fixture(t, { enabled: false });
  assert.equal(await disabled.open(), 503); assert.equal(disabled.connects, 0);
});

test("Muse egress drains the final encrypted bytes before normal upstream EOF", async t => {
  const expected = randomBytes(65536 + 31);
  const f = await fixture(t, { handleSocket: socket => socket.once("data", () => socket.end(expected)) });
  const ws = await f.open(), chunks = [];
  ws.on("message", chunk => chunks.push(Buffer.from(chunk)));
  const closed = once(ws, "close"); ws.send(Buffer.from([0x16, 3, 3]));
  await closed;
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.equal(f.gateway.active, 0);
});
