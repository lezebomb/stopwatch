import { chromium } from "@playwright/test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("preview-dist");
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
    if (!file.startsWith(root + path.sep)) throw new Error();
    res.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.EDGE_BIN || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    let last = "ready", ssid = "", connected = false;
    window.setupWrites = [];
    const command = { async writeValueWithResponse(bytes) {
      const text = new TextDecoder().decode(bytes);
      window.setupWrites.push(text);
      const split = text.indexOf("="), key = text.slice(0, split), value = text.slice(split + 1);
      if (key === "wifi.ssid") ssid = value;
      if (key === "wifi.connect") connected = true;
      last = key === "sync.status" ? "sync.status: paired" : `${key}: ok`;
    } };
    const status = { async readValue() { return new TextEncoder().encode(JSON.stringify({ name: "MuseGadget-TEST", fw: "test", wifi: { state: connected || window.alreadyOnline ? "connected" : "no_network", ssid }, last })); } };
    const device = { addEventListener() {}, gatt: { connected: false, async connect() { this.connected = true; return { async getPrimaryService() { return { async getCharacteristic(id) { return id.includes("0002") ? command : status; } }; } }; }, disconnect() { this.connected = false; } } };
    Object.defineProperty(navigator, "bluetooth", { value: { async requestDevice() { return device; } } });
  });
  const errors = [], extraNetwork = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => { if (!/\/(setup\/)?(index\.html|app\.[a-f\d]+\.js|style\.[a-f\d]+\.css)$|\/setup\/$/.test(new URL(req.url()).pathname)) extraNetwork.push(req.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/setup/`);
  await page.getByRole("button", { name: "连接挂件", exact: true }).click();
  await page.locator("#ssid").fill("出门热点");
  await page.locator("#password").fill("test-only-pass");
  await page.getByRole("button", { name: "保存到挂件并连接" }).click();
  await page.getByRole("status").filter({ hasText: "已连接 出门热点" }).waitFor();
  assert.equal(await page.locator("#password").inputValue(), "");
  assert.deepEqual(await page.evaluate(() => window.setupWrites), ["wifi.ssid=出门热点", "wifi.pass=test-only-pass", "wifi.connect="]);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.addInitScript(() => { window.alreadyOnline = true; });
  const code = "P".repeat(32);
  await page.goto(`http://127.0.0.1:${server.address().port}/setup/?authorization=1#device=${code}`);
  await page.getByRole("button", { name: "连接挂件", exact: true }).click();
  await page.getByRole("button", { name: "授权这台挂件", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "挂件已获授权" }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
  assert.deepEqual(await page.evaluate(() => window.setupWrites), [`sync.enroll=${code}`, "sync.status="]);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(extraNetwork, []);
  assert.deepEqual(errors, []);
  console.log("Phone setup browser passed: BLE command sequence, cleared password, no API/WS/storage, mobile layout. Physical Android BLE still requires user verification.");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
