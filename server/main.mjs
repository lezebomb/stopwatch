import { createRelay } from "./app.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { secret } from "./store.mjs";
await mkdir(".data", { recursive: true });
let bridgeToken;
try {
  bridgeToken = await readFile(".data/bridge.key", "utf8");
} catch {
  bridgeToken = secret();
  await writeFile(".data/bridge.key", bridgeToken, { mode: 0o600 });
}
const app = await createRelay({
  directory: process.env.STOPWATCH_DATA_DIR || ".data",
  webRoot: process.env.STOPWATCH_WEB_ROOT || "dist",
  bridgeToken,
  port: Number(process.env.PORT || 8787),
  mode: process.env.STOPWATCH_MODE || "mock",
  publicOrigin: process.env.STOPWATCH_PUBLIC_ORIGIN || null,
  allowExecution: process.env.STOPWATCH_ENABLE_EXECUTION === "1",
});
const ticket = app.store.ticket();
console.log(
  `StopWatch ${process.env.STOPWATCH_MODE === "production" ? "PRODUCTION" : "MOCK"} relay: ${app.url}\n两分钟一次性配对链接: ${process.env.STOPWATCH_PUBLIC_ORIGIN || app.url}/#pair=${ticket.code}\n模拟器: ${app.url}/simulator`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
