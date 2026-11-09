import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
test("SQLite survives restart; replay is bounded and quota snapshot survives eviction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sw-store-"));
  let store = new Store(dir);
  try {
    const session = store.pair(store.ticket().code);
    store.settings({ brightness: 50 });
    store.event({
      id: "quota",
      type: "quota",
      payload: { mode: "mock", primary: { usedPercent: 12 } },
    });
    for (let i = 0; i < 1100; i++)
      store.event({ id: `event-${i}`, type: "history", payload: { i } });
    store.close();
    store = new Store(dir);
    assert(store.session(session.token));
    assert.equal(store.settings().brightness, 50);
    assert.equal(store.events().length, 1000);
    assert.equal(store.snapshot("quota").primary.usedPercent, 12);
    assert.equal(
      store.event({ id: "event-1099", type: "history", payload: { i: 1 } }),
      null,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
test("idempotency rejects changed payload and bounds offline commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sw-queue-"));
  const store = new Store(dir);
  try {
    assert.equal(
      store.command({ id: "same", action: "start", text: "a" }),
      true,
    );
    assert.equal(
      store.command({ id: "same", action: "start", text: "a" }),
      false,
    );
    assert.throws(
      () => store.command({ id: "same", action: "start", text: "b" }),
      /幂等键/,
    );
    for (let i = 1; i < 100; i++)
      store.command({ id: `start-${i}`, action: "start", text: "a" });
    assert.throws(
      () => store.command({ id: "overflow", action: "start", text: "a" }),
      /100/,
    );
    for (let i = 0; i < 28; i++)
      store.command({ id: `stop-${i}`, action: "interrupt", taskId: "same" });
    assert.throws(
      () =>
        store.command({
          id: "overflow-2",
          action: "interrupt",
          taskId: "same",
        }),
      /队列已满/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
