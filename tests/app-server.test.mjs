import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AppServerTransport } from "../bridge/app-server.mjs";
test("stdio JSON RPC adapter exchanges handshake, thread/turn methods, notifications and same-id approvals with fake server", async (t) => {
  const notifications = [],
    approvals = [];
  const rpc = new AppServerTransport({
    executable: process.execPath,
    args: [path.resolve("tests/app-server.fixture.mjs")],
    cwd: process.cwd(),
    onNotification: (n) => notifications.push(n),
    onApproval: (r) => approvals.push(r),
  });
  t.after(() => rpc.close());
  assert.equal((await rpc.initialize()).mock, true);
  assert.equal((await rpc.list()).data[0].id, "thread-mock");
  await rpc.start(process.cwd());
  await rpc.read("thread-mock");
  await rpc.resume("thread-mock");
  await rpc.turn("thread-mock", "mock task");
  assert.equal(approvals[0].id, 700);
  rpc.respondApproval(700, "decline");
  await rpc.steer("thread-mock", "turn-mock", "extra text");
  await rpc.interrupt("thread-mock", "turn-mock");
  assert.equal((await rpc.quota()).mock, true);
  assert(notifications.some((n) => n.method === "turn/started"));
  assert(
    notifications.some(
      (n) =>
        n.method === "mock/approvalDecision" && n.params.decision === "decline",
    ),
  );
  await assert.rejects(
    rpc.request("turn/steer", { threadId: "thread-mock" }),
    /expectedTurnId/,
  );
  assert.throws(() => rpc.respondApproval(700, "always"), /Unsupported/);
});
