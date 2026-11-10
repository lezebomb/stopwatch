import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { BridgeUpdateManager } from "./update-manager.mjs";
import { atomicJson, readJson } from "../updates/atomic.mjs";
const exec = promisify(execFile);
const root = path.resolve(
  process.argv[2] ||
    process.env.STOPWATCH_HOME ||
    path.dirname(process.argv[1]),
);
await mkdir(root, { recursive: true });
const lockfile = path.join(root, "supervisor.lock");
let lock;
try {
  lock = await open(lockfile, "wx");
  await lock.writeFile(String(process.pid));
} catch {
  const pid = Number(await readFile(lockfile, "utf8").catch(() => 0));
  try {
    process.kill(pid, 0);
    process.exit(0);
  } catch {
    await unlink(lockfile).catch(() => {});
    lock = await open(lockfile, "wx");
    await lock.writeFile(String(process.pid));
  }
}
const config = await readJson(path.join(root, "config.json"));
if (!config) throw new Error("Install and authorize this bridge first");
let stopped = false,
  child,
  retry,
  updateTimer,
  healthyTimer,
  restarts = 0,
  updateFailures = 0,
  childBusy = false,
  lastHealth = 0,
  lastStatus = {};
const report = async (status) => {
  lastStatus = { ...lastStatus, ...status };
  await atomicJson(path.join(root, "status.json"), {
    ...lastStatus,
    time: Date.now(),
    supervisorPid: process.pid,
    pid: child?.pid || null,
  });
};
function stopChild() {
  const target = child;
  if (!target) return;
  target.send?.({ type: "stop" });
  setTimeout(() => {
    if (target.exitCode === null) target.kill();
  }, 2000).unref();
}
const publicKey = await readFile(
  path.join(root, "release-public.pem"),
  "utf8",
).catch(() => null);
const manager = new BridgeUpdateManager(root, {
  publicKey,
  manifestUrl: config.updateManifestUrl,
  currentVersion: config.version || "0.2.0",
});
async function token() {
  if (process.platform !== "win32")
    throw new Error("Windows user-scoped DPAPI required");
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "app", "Decrypt-Credential.ps1"),
      "-Root",
      root,
    ],
    { windowsHide: true, maxBuffer: 65536 },
  );
  return stdout.trim();
}
async function boot() {
  if (stopped) return;
  let credential;
  try {
    credential = await token();
  } catch {
    stopped = true;
    await report({
      state: "authorization-required",
      online: false,
      detail: "无法恢复本用户的授权，请打开设置重新配对",
    });
    return;
  }
  const selection = await manager.selectForBoot();
  const script = selection.active || path.join(root, "app", "bridge.mjs");
  childBusy = false;
  const node = path.join(root, "runtime", "node.exe");
  child = spawn(node, [script], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const version = selection.pending?.version || selection.currentVersion;
  child.stdin.end(JSON.stringify({ config: { ...config, version }, token: credential, root }) + "\n");
  credential = null;
  await report({ state: "starting", online: false, version, updateState: selection.lastResult || "idle" });
  lastHealth = 0;
  healthyTimer = setTimeout(() => {
    if (!lastHealth || Date.now() - lastHealth > 10000) stopChild();
    else {
      restarts = 0;
      manager.healthy().catch(() => {});
    }
  }, 45000);
  child.on("message", async (message) => {
    if (message?.type === "health" && message.localReady)
      lastHealth = Date.now();
    if (message?.type === "status") {
      childBusy = !!message.busy;
      await report(message);
      if (
        message.state === "authorization-required" ||
        message.state === "revoked"
      ) {
        stopped = true;
        clearTimeout(retry);
        clearTimeout(updateTimer);
        if (child?.exitCode === null) stopChild();
      }
      if (!pending) await report({ updateState: result.state, updateDetail: "" });
    }
  });
  // Never forward raw child output or credentials into persistent logs.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.on("exit", async () => {
    clearTimeout(healthyTimer);
    if (!stopped) await report({ state: "offline", online: false });
    if (!stopped)
      retry = setTimeout(
        boot,
        Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5)),
      );
  });
  child.on("error", async () => {
    await report({ state: "start-failed", online: false });
    if (!stopped) {
      clearTimeout(retry);
      retry = setTimeout(boot, 5000);
    }
  });
}
async function update() {
  if (stopped) return;
  let pending = false;
  try {
    if (!childBusy) {
      const result = await manager.check();
      pending = result.state === "staged" || result.state === "pending";
      if (pending && !childBusy) {
        await report({ updateState: "restarting" });
        stopChild();
      }
      updateFailures = 0;
    }
  } catch (error) {
    updateFailures++;
    await report({
      updateState: "retry-wait",
      updateDetail: "更新校验或下载失败，保留当前版本",
    });
  } finally {
    if (!stopped)
      updateTimer = setTimeout(
        update,
        pending || childBusy
          ? 60000
          : Math.min(
              21600000,
              updateFailures
                ? 60000 * 2 ** Math.min(updateFailures - 1, 8)
                : 21600000,
            ),
      );
  }
}
async function stop() {
  stopped = true;
  clearTimeout(retry);
  clearTimeout(updateTimer);
  clearTimeout(healthyTimer);
  stopChild();
  await new Promise((r) => setTimeout(r, 1000));
  await report({ state: "stopped", online: false });
  await lock?.close();
  await unlink(lockfile).catch(() => {});
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
await boot();
if (!stopped) updateTimer = setTimeout(update, 60000);
setInterval(async () => {
  try {
    await readFile(path.join(root, "stop.request"));
    await unlink(path.join(root, "stop.request"));
    await stop();
  } catch {}
}, 1000).unref();
