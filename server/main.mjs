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
  bridgeToken,
  port: Number(process.env.PORT || 8787),
});
const ticket = app.store.ticket();
console.log(
  `StopWatch MOCK relay: ${app.url}\n两分钟一次性配对链接: ${app.url}/#pair=${ticket.code}\n模拟器: ${app.url}/simulator`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
