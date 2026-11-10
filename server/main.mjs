import { createRelay } from "./app.mjs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { secret } from "./store.mjs";
import path from "node:path";
const mode = process.env.STOPWATCH_MODE || "mock";
const directory = process.env.STOPWATCH_DATA_DIR || ".data";
if (mode === "production") {
  if (!path.isAbsolute(directory)) throw new Error("Production requires an absolute persistent STOPWATCH_DATA_DIR");
  const release = await realpath(process.cwd());
  const withinRelease = target => target === release || target.startsWith(release + path.sep);
  if (withinRelease(path.resolve(directory))) throw new Error("Keep production data outside the release");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (withinRelease(await realpath(directory))) throw new Error("Keep production data outside the release");
}
let bridgeToken;
if (mode === "mock") {
  await mkdir(directory, { recursive: true });
  const key = path.join(directory, "bridge.key");
  try { bridgeToken = await readFile(key, "utf8"); }
  catch {
    bridgeToken = secret();
    await writeFile(key, bridgeToken, { mode: 0o600, flag: "wx" });
  }
}
const app = await createRelay({
  directory,
  webRoot: process.env.STOPWATCH_WEB_ROOT || "dist",
  bridgeToken,
  port: Number(process.env.PORT || 8787),
  mode,
  publicOrigin: process.env.STOPWATCH_PUBLIC_ORIGIN || null,
  allowExecution: process.env.STOPWATCH_ENABLE_EXECUTION === "1",
});
console.log(`StopWatch ${mode} relay: ${app.url}`);
if (mode === "mock") console.log(`两分钟一次性配对链接: ${app.url}/#pair=${app.store.ticket().code}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
