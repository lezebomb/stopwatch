import { readFile } from "node:fs/promises";
import { connectBridge } from "./client.mjs";
if (process.env.CODEX_MODE && process.env.CODEX_MODE !== "mock")
  throw new Error("此 MVP 只允许 mock；真实 App Server 需收礼人授权后单独接线");
const token =
  process.env.STOPWATCH_BRIDGE_TOKEN ||
  (await readFile(".data/bridge.key", "utf8"));
const bridge = connectBridge({
  url: process.env.STOPWATCH_RELAY_URL || "ws://127.0.0.1:8787",
  token,
  onStatus: (online) =>
    console.log(
      `Mock Windows bridge ${online ? "connected" : "disconnected; retrying"}`,
    ),
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    bridge.close();
    setTimeout(() => process.exit(0), 200);
  });
