import { chromium } from "@playwright/test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mockIdentity } from "../updates/mock-server.mjs";
import { createRelay } from "../server/app.mjs";
import { digest } from "../server/store.mjs";
import { phoneRef } from "../server/phone-pairing.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "sw-phone-browser-"));
let browser, relay, gateway;
const connections = new Set();
try {
  const identity = await mockIdentity(path.join(directory, "test-tls"));
  let origin;
  const headers = req => ({ ...req.headers, host: new URL(origin).host, "x-forwarded-proto": "https" });
  gateway = https.createServer({ key: identity.tlsKey, cert: identity.ca }, (req, res) => {
    const upstream = http.request(`${relay.url}${req.url}`, { method: req.method, headers: headers(req) }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    }); upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  gateway.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(relay.server.address().port, "127.0.0.1", () => {
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers(req)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    }); connections.add(upstream); upstream.on("close", () => connections.delete(upstream));
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${gateway.address().port}`;
  relay = await createRelay({ directory: path.join(directory, "relay"), port: 0, mode: "production", publicOrigin: origin, webRoot: "production-dist" });
  const device = relay.store.pair(relay.store.ticket("device").code), hash = digest(device.token), ref = phoneRef(hash);
  browser = await chromium.launch({ executablePath: process.env.EDGE_BIN || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  let bleRequests = 0;
  await context.exposeBinding("recordBle", () => { bleRequests++; });
  await context.addInitScript(({ hash, ref }) => {
    let last = "ready", challenge = "";
    const status = { readValue: async () => new TextEncoder().encode(JSON.stringify({ name: "MuseGadget-FIXTURE", fw: "fixture", wifi: { state: "no_network" }, last })) };
    const command = { async writeValueWithResponse(bytes) {
      const text = new TextDecoder().decode(bytes), at = text.indexOf("="), key = text.slice(0, at), value = text.slice(at + 1);
      if (key.startsWith("wifi.")) throw new Error("Pairing must not require Wi-Fi credentials");
      let result = "ok";
      if (key === "phone.ref") result = ref;
      else if (key === "phone.begin") challenge = value;
      else if (key === "phone.prove") {
        if (value !== "123456") result = "wrong-code";
        else {
          const bytes = Uint8Array.from(hash.match(/../g), n => parseInt(n, 16));
          const handle = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const proof = await crypto.subtle.sign("HMAC", handle, new TextEncoder().encode(`SWPHONE1:${challenge}:${value}`));
          result = [...new Uint8Array(proof)].map(n => n.toString(16).padStart(2, "0")).join("");
        }
      } else throw new Error("Unexpected Bluetooth command");
      last = `${key}: ${result}`;
    } };
    const device = { addEventListener() {}, gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async id => id.includes("0002") ? command : status }) }; }, disconnect() { this.connected = false; } } };
    Object.defineProperty(navigator, "bluetooth", { value: { async requestDevice() { await window.recordBle(); return device; } } });
  }, { hash, ref });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/pair/?device=${ref}`);
  await page.locator("#start").click(); await page.locator("#code").fill("000000"); await page.locator("#submit").click();
  await page.locator("#message").filter({ hasText: "验证码不正确" }).waitFor();
  await page.locator("#code").fill("123456"); await page.locator("#submit").click();
  await page.getByRole("heading", { name: "当前封面", exact: true }).waitFor();
  assert.equal(await page.locator("#pair-code").count(), 0);
  assert.match(await page.locator(".connection-grid").innerText(), /等待联网/);
  assert.equal(bleRequests, 1);
  await page.goto(`${origin}/pair/?device=${ref}`);
  await page.getByRole("heading", { name: "当前封面", exact: true }).waitFor();
  assert.equal(bleRequests, 1, "A valid paired phone must not re-open Bluetooth");
  await page.locator('[data-page="photos"]').first().click();
  const png = await sharp({ create: { width: 48, height: 64, channels: 3, background: "#5a927c" } }).png().toBuffer();
  await page.locator("#upload").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "保存这张照片", exact: true }).click();
  await page.locator("[data-delete]").waitFor();
  const photo = relay.store.photos()[0]; assert.ok(photo);
  assert.equal((await readFile(path.join(directory, "relay", `${photo.id}.rgb565`))).length, 466 * 466 * 2);
  assert.match(await page.locator("main").innerText(), /压缩不会减少/);
  await page.locator(`[data-cover="${photo.id}"]`).click();
  await page.waitForFunction(() => document.body.textContent.includes("当前封面"));
  assert.equal(relay.store.settings().defaultPhoto, photo.id);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await mkdir(".data/interaction-v025", { recursive: true });
  await page.screenshot({ path: ".data/interaction-v025/phone-photos.png" });
  await page.locator('[data-page="overview"]').first().click();
  await page.screenshot({ path: ".data/interaction-v025/phone-home.png" });
  await page.evaluate(async () => { const state = await (await fetch("/api/state")).json(); await fetch("/api/phone/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.session.id, role: "revoke" }) }); });
  const revoked = await context.request.get(`${origin}/api/state`); assert.equal(revoked.status(), 401);
  console.log("Passed: secure one-step pairing, wrong code, offline console, repeat scan without BLE, circular crop/upload RGB565, cover selection, phone revoke, 390px layout. Bluetooth here is a fixture, not hardware acceptance.");
} finally {
  if (browser) await browser.close();
  if (relay) await relay.close();
  for (const socket of connections) socket.destroy();
  if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(directory, { recursive: true, force: true });
}
