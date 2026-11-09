// Opt-in real-account, real-USB check. One no-tools turn; never part of CI.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { AppServerCodex } from "../bridge/real-engine.mjs";
const port = process.argv[2];
const executable = process.argv[3];
assert(
  port && executable,
  "usage: node tests/hardware-codex.mjs COMx /absolute/codex.exe",
);
await mkdir(".data", { recursive: true });
const usb = spawn(
  path.resolve(
    ".tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe",
  ),
  ["scripts/device-sync.py", "--port", port, "--pipe"],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
usb.stderr.on("data", () => {});
let sequence = 0,
  chain = Promise.resolve();
const pending = new Map(),
  observed = [];
function command(op, values = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("USB state acknowledgement timeout"));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    usb.stdin.write(JSON.stringify({ id, op, ...values }) + "\n");
  });
}
createInterface({ input: usb.stdout }).on("line", (line) => {
  try {
    const message = JSON.parse(line),
      waiting = pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    message.error
      ? waiting.reject(new Error(message.error))
      : waiting.resolve(message.reply);
  } catch {}
});
usb.on("exit", () => {
  for (const value of pending.values()) {
    clearTimeout(value.timer);
    value.reject(new Error("USB helper stopped"));
  }
  pending.clear();
});
let readyResolve, doneResolve, engine;
const ready = new Promise((r) => (readyResolve = r)),
  done = new Promise((r) => (doneResolve = r));
const timeout = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Real App Server did not complete within 90s")),
        90000,
      );
      timer.unref();
    }),
  ]);
try {
  const before = await command("info");
  engine = new AppServerCodex({
    executable,
    workspaces: [{ id: "hardware", name: "StopWatch", path: process.cwd() }],
    onStatus: (state) => {
      if (state.online) readyResolve();
      if (state.state === "authorization-required")
        doneResolve({ state: "authorization-required" });
    },
    emit: (type, task) => {
      if (type !== "task") return;
      observed.push(task.state);
      chain = chain.then(async () => {
        await command("task", {
          source: "app-server",
          online: true,
          state: task.state,
          title: "StopWatch link check",
        });
        const current = await command("info");
        assert.equal(current.codexOnline, true);
        await writeFile(
          ".data/hardware-real-codex-live.json",
          JSON.stringify({
            state: task.state,
            devicePhase: current.codexPhase,
            time: Date.now(),
            mode: "production",
          }),
        );
      });
      if (["completed", "failed", "interrupted"].includes(task.state))
        doneResolve(task);
    },
  });
  await timeout(ready);
  await engine.command({
    action: "start",
    id: "hardware-link-" + Date.now(),
    projectId: "hardware",
    text: "This is a hardware link check. Reply only: StopWatch link OK. Do not use tools. Do not read or write any files.",
  });
  const result = await timeout(done);
  await chain;
  assert.equal(
    result.state,
    "completed",
    "Real Codex turn failed; raw diagnostics stay private",
  );
  const after = await command("info");
  assert.equal(after.codexPhase, 5);
  assert.equal(
    after.displaySha256,
    before.displaySha256,
    "Task sync must not replace the photo cover",
  );
  // A few quiet live heartbeats exercise the same sustained state delivery,
  // without making more model requests or replaying synthetic task events.
  const samples = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    await command("task", {
      source: "app-server",
      online: true,
      state: result.state,
      title: "StopWatch link check",
    });
    samples.push(await command("info"));
  }
  const report = {
    passed: true,
    source: "real App Server",
    states: [...new Set(observed)],
    before,
    after,
    samples,
  };
  await writeFile(
    ".data/hardware-real-codex-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      source: report.source,
      states: report.states,
      finalDevicePhase: after.codexPhase,
      internalFreeRange: [
        Math.min(...samples.map((s) => s.internalFree)),
        Math.max(...samples.map((s) => s.internalFree)),
      ],
    }),
  );
} finally {
  try {
    await chain;
    await command("task", {
      source: "app-server",
      online: false,
      state: "idle",
      title: "",
    });
  } catch {}
  engine?.close();
  usb.stdin.end();
  setTimeout(() => usb.kill(), 1000).unref();
}
