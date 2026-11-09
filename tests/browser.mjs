import { chromium } from "@playwright/test";
import { createRelay } from "../server/app.mjs";
import { connectBridge } from "../bridge/client.mjs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(path.join(os.tmpdir(), "stopwatch-browser-"));
const relay = await createRelay({ directory, port: 0 });
const bridge = connectBridge({
  url: relay.url.replace("http", "ws"),
  token: relay.bridgeToken,
  directory,
  delay: 400,
});
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.EDGE_BIN ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${relay.url}/#pair=${relay.store.ticket().code}`);
  await page.getByRole("heading", { name: "一切都在，慢慢来。" }).waitFor();
  await page.locator("canvas").waitFor();
  await page.waitForTimeout(300);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  await page
    .locator("canvas")
    .click({ position: { x: 150, y: 150 }, clickCount: 5, delay: 80 });
  await page.waitForFunction(() =>
    document
      .querySelector("canvas")
      ?.getAttribute("aria-label")
      ?.startsWith("彩蛋"),
  );
  await page.locator("canvas").click();
  const yellow = await page.locator("#yellow").boundingBox();
  await page.mouse.move(
    yellow.x + yellow.width / 2,
    yellow.y + yellow.height / 2,
  );
  await page.mouse.down();
  await page.waitForFunction(() =>
    document
      .querySelector("canvas")
      ?.getAttribute("aria-label")
      ?.includes("正在听"),
  );
  await page.mouse.up();
  await page.waitForFunction(() =>
    document
      .querySelector("canvas")
      ?.getAttribute("aria-label")
      ?.includes("MOCK 回复"),
  );
  await page.getByRole("button", { name: "Codex 任务", exact: false }).click();
  await page.locator("#prompt").fill("浏览器测试并申请审批");
  await page.getByRole("button", { name: "创建 Mock 任务" }).click();
  await page.getByRole("button", { name: "批准本次" }).waitFor();
  await page.getByRole("button", { name: "批准本次" }).click();
  await page.locator(".result").filter({ hasText: "模拟结果" }).waitFor();
  await page.locator("#continuation").fill("模拟失败");
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await page.locator(".result").filter({ hasText: "演示失败" }).waitFor();
  await page.getByRole("button", { name: "照片时光", exact: false }).click();
  await page
    .locator("#upload")
    .setInputFiles(path.resolve("assets/photos/0.jpg"));
  await page.locator(".photo-tile").filter({ hasText: "0.jpg" }).waitFor();
  await page
    .locator(".photo-tile")
    .filter({ hasText: "0.jpg" })
    .getByRole("button", { name: "设为封面" })
    .click();
  await page.getByRole("button", { name: "设备设置", exact: false }).click();
  await page.locator("#egg-message").fill("浏览器测试彩蛋留言");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "新建只读端" }).click();
  await page.locator(".qr").waitFor();
  await page.getByRole("button", { name: "模拟事件连接断开 / 重连" }).click();
  await page.waitForTimeout(2300);
  assert(
    (await page.getByText("中转服务：在线", { exact: false }).count()) > 0,
  );
  await page.getByRole("button", { name: "陪伴总览", exact: false }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "mobile horizontal overflow",
  );
  await page.locator("#charging").uncheck();
  await page.locator("#battery").fill("3");
  await page.waitForFunction(
    () =>
      document.querySelector("canvas")?.getAttribute("aria-label") ===
      "屏幕已休眠",
  );
  await page.locator("#charging").check();
  await page.waitForFunction(
    () =>
      document.querySelector("canvas")?.getAttribute("aria-label") !==
      "屏幕已休眠",
  );
  await page.getByRole("button", { name: "指南", exact: true }).click();
  await page.getByRole("button", { name: "照片", exact: true }).click();
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(
    "Browser E2E passed: desktop/mobile, pairing, approval, continuation/failure, photo upload/default, settings, QR, reconnect, simulator controls.",
  );
} finally {
  await browser?.close();
  bridge.close();
  await new Promise((r) => setTimeout(r, 160));
  await relay.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 150,
  });
}
