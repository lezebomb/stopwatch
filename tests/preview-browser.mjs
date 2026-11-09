import { chromium } from "@playwright/test";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("preview-dist");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const relative = url.pathname.replace(/^\/stopwatch\//, "") || "index.html";
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error("invalid path");
    res.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".jpg")
              ? "image/jpeg"
              : "application/json",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.EDGE_BIN ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [],
    network = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("websocket", (socket) => network.push(socket.url()));
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (
      /^https?:$/.test(url.protocol) &&
      (/\/api\/|\/events\?/.test(url.pathname) || url.hostname !== "127.0.0.1")
    )
      network.push(r.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/stopwatch/`);
  await page.getByRole("heading", { name: "一切都在，慢慢来。" }).waitFor();
  await page.locator("canvas").waitFor();
  await page.getByRole("button", { name: "Codex 任务", exact: false }).click();
  await page.locator("#prompt").fill("在线隔离演示");
  await page.getByRole("button", { name: "创建 Mock 任务" }).click();
  await page.locator(".result").filter({ hasText: "模拟结果" }).waitFor();
  await page.getByRole("button", { name: "照片时光", exact: false }).click();
  await page.locator("#upload").setInputFiles("assets/photos/1.jpg");
  await page.locator(".photo-tile").filter({ hasText: "1.jpg" }).waitFor();
  assert.deepEqual(
    network,
    [],
    "Static preview must not call any production API or WebSocket",
  );
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/online-preview.png",
    fullPage: true,
  });
  console.log(
    "Static preview E2E passed under /stopwatch/: instant opening, local tasks/uploads, zero API/WebSocket requests.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
