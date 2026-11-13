// Controlled UI transport fixture only. Never calls Codex, production APIs or audio.
import { chromium } from "@playwright/test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { defaultSettings } from "../shared/model.mjs";

export async function remoteControlUiChecks(browser, webRoot = "dist") {
  const root = path.resolve(webRoot);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    try {
      assert(file.startsWith(root + path.sep));
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  try {
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const old = { id: "fixture-old", title: "Earlier fixture", state: "working", project: "Fixture", updated: 1, mode: "production" };
    const snapshot = { mode: "production", settings: defaultSettings, bridgeOnline: true, codex: { online: true }, photos: [],
      tasks: [old], session: { role: "operator" }, sessions: [], commandReceipts: [], workspaces: [{ id: "fixture", name: "Fixture" }] };
    let socket, submission, seq = 0;
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname.endsWith("/state") ? snapshot : pathname.endsWith("/events") ? { events: [] } : { mode: "production" } });
    });
    await page.route("**/api/commands", route => submission?.({ route, body: route.request().postDataJSON() }));
    await page.routeWebSocket("**/events?*", ws => { socket = ws; ws.send(JSON.stringify({ type: "snapshot", state: snapshot })); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('button[data-page="tasks"]').first().click();
    await page.locator('#continuation').fill("Draft belongs to the earlier task");
    const received = new Promise(resolve => { submission = resolve; });
    await page.locator('#prompt').fill("New fixture command");
    await page.locator('#task-form button').click();
    const command = await received;
    await page.locator('#continuation').focus();
    const send = (type, payload) => socket.send(JSON.stringify({ type: "event", event: { id: crypto.randomUUID(), type, payload, seq: ++seq } }));
    send("commandStatus", { commandId: command.body.id, taskId: command.body.id, stage: "succeeded" });
    send("task", { ...old, id: command.body.id, title: "Newest fixture", state: "completed", updated: 2 });
    await page.locator(`button[data-task="${command.body.id}"]`).waitFor();
    await command.route.fulfill({ status: 202, json: { receipt: { commandId: command.body.id, taskId: command.body.id, stage: "received" } } });
    await page.locator('.command-receipt', { hasText: "执行成功" }).waitFor();
    assert.equal(await page.locator('#continuation').inputValue(), "", "event refresh cannot copy another task's draft");
    await page.locator('button[data-task="fixture-old"]').click();
    assert.equal(await page.locator('#continuation').inputValue(), "Draft belongs to the earlier task");
    const pending = new Promise(resolve => { submission = resolve; });
    await page.locator('#prompt').fill("Pending fixture command");
    await page.locator('#task-form button').click();
    const queued = await pending;
    await queued.route.fulfill({ status: 202, json: { receipt: { commandId: queued.body.id, taskId: queued.body.id, stage: "received" } } });
    await page.locator('.command-receipt', { hasText: "中转已接收" }).waitFor();
    assert.match(await page.locator('.panel-grid > section.card').innerText(), /电脑尚未返回对应会话/);
    assert.deepEqual(errors, []);
    console.log("UI transport fixture passed: delayed 202, per-task draft isolation, pending receipt visibility; no real execution.");
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_BIN || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  try { await remoteControlUiChecks(browser, process.argv[2] || "dist"); }
  finally { await browser.close(); }
}
