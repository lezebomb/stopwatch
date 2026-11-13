import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { createDeviceSync } from "../server/device-sync.mjs";
import { AppServerTransport } from "../bridge/app-server.mjs";
import { AppServerCodex } from "../bridge/real-engine.mjs";
import { createCommandDispatcher, mergeCommandReceipt } from "../web/command-dispatch.mjs";

test("a delayed HTTP 202 cannot erase an official completed/failed receipt from WSS", () => {
  for (const stage of ["succeeded", "failed", "interrupted"]) {
    const final = [{ commandId: "same-command", taskId: "same-task", stage }];
    assert.equal(mergeCommandReceipt(final, { commandId: "same-command", taskId: "same-task", stage: "received" }), final);
  }
  const unknown = [{ commandId: "same-command", stage: "uncertain" }];
  assert.equal(mergeCommandReceipt(unknown, { commandId: "same-command", stage: "executing" })[0].stage, "executing");
});

test("ambiguous HTTP retries reuse the command id; parallel clicks share one submission", async () => {
  const requests = [];
  let attempt = 0;
  const send = createCommandDispatcher(async c => {
    requests.push(c);
    if (++attempt === 1) throw new TypeError("connection lost after server commit");
    return { receipt: { stage: "received" } };
  });
  const command = { action: "start", text: "inspect", sandbox: "read-only" };
  await assert.rejects(send(command), /connection lost/);
  const [a, b] = await Promise.all([send(command), send(command)]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(a.id, b.id);
});

test("acknowledgement never claims execution success; delayed events cannot regress terminal receipts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-receipts-"));
  const store = new Store(directory);
  try {
    store.command({ id: "receipt-command", action: "start", actor: "bound-device" });
    store.ack("receipt-command");
    assert.equal(store.receipt("receipt-command").stage, "received");
    for (const stage of ["executing", "accepted", "succeeded", "accepted", "failed"])
      store.commandStatus({ commandId: "receipt-command", stage });
    assert.equal(store.receipt("receipt-command").stage, "succeeded");
    assert.equal(store.receipts("other-device").length, 0);
    assert.equal(store.receipts("bound-device").length, 1);
    assert.equal(store.command({ id: "receipt-command", action: "start", actor: "bound-device" }), false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("device receipt stays compact even when the full web error contains long escaped content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sw-wire-receipt-"));
  const store = new Store(directory);
  try {
    store.command({ id: "long-error-command", action: "start", actor: "bound-device" });
    store.commandStatus({ commandId: "long-error-command", stage: "failed", message: "\u0000".repeat(512) });
    const sync = createDeviceSync(store, directory, () => false);
    const data = await sync.snapshot("bound-device");
    assert.deepEqual(Object.keys(data.codex.receipt).sort(), ["commandId", "stage", "updated"]);
    assert.equal(data.codex.receipt.stage, "failed");
    assert.equal(store.receipt("long-error-command").message.length, 512);
    assert.equal((await sync.snapshot("another-device")).codex.receipt, null);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("read-only is enforced in official thread/resume/turn protocol fields", async () => {
  const calls = [];
  const rpc = Object.create(AppServerTransport.prototype);
  rpc.request = async (method, params) => { calls.push({ method, params }); return {}; };
  await rpc.start("D:/allowed", "model", "read-only");
  await rpc.resume("thread", "D:/allowed", "model", "read-only");
  await rpc.turn("thread", "inspect", "model", "read-only");
  assert.deepEqual(calls.slice(0, 2).map(c => [c.params.sandbox, c.params.approvalPolicy]), [["read-only", "never"], ["read-only", "never"]]);
  assert.deepEqual(calls[2].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
});

test("read-only task refuses a server response that restores write access", async () => {
  let writable = false;
  const policy = () => ({ sandbox: { type: writable ? "workspaceWrite" : "readOnly" }, approvalPolicy: "never", thread: { id: "owned-readonly", turns: [] } });
  const engine = new AppServerCodex({ emit() {}, workspaces: [{ id: "safe", path: path.resolve(".data/codex-e2e/workspace-a"), name: "Safe" }],
    transportFactory: () => ({ initialize: async () => ({}), quota: async () => ({}), close() {},
      start: async () => policy(), resume: async () => policy(), turn: async () => ({ turn: { id: "read-turn" } }),
    }),
  });
  try {
    for (let n = 0; n < 20 && !engine.ready; n++) await new Promise(r => setTimeout(r, 5));
    await engine.command({ id: "readonly-command", action: "start", sandbox: "read-only", text: "inspect" });
    engine.notify({ method: "turn/completed", params: { threadId: "owned-readonly", turn: { id: "read-turn", status: "completed" } } });
    writable = true;
    await assert.rejects(engine.command({ id: "readonly-continue", action: "continue", taskId: "readonly-command", text: "inspect again" }), /未确认只读沙箱/);
  } finally { engine.close(); }
});

test("full approval digest is mandatory; oversized requests cannot be accepted; turn events determine success", async () => {
  let callbacks;
  const events = [], responses = [];
  const engine = new AppServerCodex({ workspaces: [{ id: "safe", path: path.resolve(".data/codex-e2e/workspace-a"), name: "Safe" }],
    emit: (type, payload) => events.push({ type, payload }),
    transportFactory: c => { callbacks = c; return {
      initialize: async () => ({}), quota: async () => ({}), close() {},
      start: async () => ({ thread: { id: "owned" } }), turn: async () => ({ turn: { id: "turn" } }),
      respondApproval: (id, decision) => responses.push({ id, decision }),
    }; },
  });
  try {
    for (let n = 0; n < 20 && !engine.ready; n++) await new Promise(r => setTimeout(r, 5));
    await engine.command({ id: "new-command", action: "start", text: "inspect" });
    assert(!events.some(e => e.type === "commandStatus" && e.payload.stage === "succeeded"));
    const request = command => callbacks.onApproval({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "owned", command } });
    request("literal complete command");
    let task = engine.tasks.get("new-command");
    await assert.rejects(engine.command({ id: "accept-1", action: "approve", taskId: task.id, approvalId: task.approvalId, decision: "accept" }), /完整/);
    await engine.command({ id: "accept-1", action: "approve", taskId: task.id, approvalId: task.approvalId, decision: "accept", reviewed: true, approvalDigest: task.approval.digest });
    assert.equal(responses[0].decision, "accept");
    request("long".repeat(5000)); task = engine.tasks.get(task.id);
    assert.equal(task.approval.complete, false);
    await assert.rejects(engine.command({ id: "accept-2", action: "approve", taskId: task.id, approvalId: task.approvalId, decision: "accept", reviewed: true, approvalDigest: task.approval.digest }), /完整/);
    await engine.command({ id: "decline-2", action: "approve", taskId: task.id, approvalId: task.approvalId, decision: "decline" });
    assert.equal(engine.tasks.get(task.id).state, "working");
    callbacks.onNotification({ method: "turn/completed", params: { threadId: "owned", turn: { id: "turn", status: "completed" } } });
    assert(events.some(e => e.type === "commandStatus" && e.payload.commandId === "new-command" && e.payload.stage === "succeeded"));
  } finally { engine.close(); }
});
