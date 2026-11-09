import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMockUpdates } from "../updates/mock-server.mjs";
import { signedManifest } from "../updates/security.mjs";
import { BridgeUpdateManager } from "../windows/update-manager.mjs";
import { AppServerCodex } from "../bridge/real-engine.mjs";
test("Windows staged app update rolls back without health and commits only on health; user config survives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-win-update-"));
  let server;
  try {
    server = await createMockUpdates({ directory: path.join(root, "tls") });
    const originalManifest = server.manifest; // Sign a bridge manifest through a separate local HTTPS endpoint.
    const https = await import("node:https");
    let bridgeUrl,
      nextVersion = "0.2.1",
      sequenceOffset = 0;
    const bridgeServer = https.createServer(
      { key: server.tlsKey, cert: server.ca },
      (req, res) => {
        if (req.url === "/bridge.json") {
          const m = {
            ...originalManifest(),
            kind: "bridge",
            version: nextVersion,
            sequence: originalManifest().sequence + sequenceOffset,
            hardware: "windows-x64",
            compatibility: { protocol: 1, nodeMajor: 24 },
          };
          res.end(JSON.stringify(signedManifest(m, server.privateKey)));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
    );
    await new Promise((r) => bridgeServer.listen(0, "127.0.0.1", r));
    bridgeUrl = `https://127.0.0.1:${bridgeServer.address().port}/bridge.json`;
    try {
      await writeFile(path.join(root, "config.json"), "user configuration");
      const manager = new BridgeUpdateManager(root, {
        publicKey: server.publicKey,
        manifestUrl: bridgeUrl,
        ca: server.ca,
      });
      assert.equal((await manager.check()).state, "staged");
      assert.equal(
        (await manager.selectForBoot()).lastResult,
        "pending-health",
      );
      assert.equal((await manager.selectForBoot()).lastResult, "rolled-back");
      await assert.rejects(manager.check(), /replay/);
      nextVersion = "0.2.2";
      sequenceOffset = 1;
      await manager.check();
      await manager.selectForBoot();
      await manager.healthy();
      assert.equal((await manager.state()).currentVersion, "0.2.2");
      assert.equal(
        await readFile(path.join(root, "config.json"), "utf8"),
        "user configuration",
      );
      assert.equal((await manager.state()).lastResult, "healthy");
      nextVersion = "0.2.3";
      sequenceOffset = 2;
      await manager.check();
      const staged = await manager.state();
      await writeFile(staged.pending.file, "disk damage");
      assert.equal((await manager.selectForBoot()).lastResult, "rolled-back");
      assert.equal((await manager.state()).currentVersion, "0.2.2");
    } finally {
      await new Promise((r) => bridgeServer.close(r));
    }
  } finally {
    await server?.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
test("real App Server adapter enforces workspace allowlist, owns thread IDs and binds approvals to a connection", async () => {
  const emitted = [],
    responses = [];
  let callbacks;
  const rpc = {
    initialize: async () => ({}),
    resume: async () => ({ thread: { turns: [] } }),
    quota: async () => ({ rateLimits: { primary: null, secondary: null } }),
    start: async (cwd) => {
      assert.equal(cwd, path.resolve("allowed"));
      return { thread: { id: "owned" } };
    },
    turn: async () => ({ turn: { id: "turn-owned" } }),
    respondApproval: (id, decision) => responses.push({ id, decision }),
    close: () => {},
    interrupt: async () => {},
    steer: async () => {},
  };
  const engine = new AppServerCodex({
    emit: (type, payload) => emitted.push({ type, payload }),
    workspaces: [
      { id: "allowed", path: path.resolve("allowed"), name: "Allowed" },
    ],
    transportFactory: (c) => {
      callbacks = c;
      return rpc;
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      engine.command({
        action: "start",
        id: "bad",
        projectId: "outside",
        text: "test",
      }),
      /授权范围/,
    );
    await engine.command({
      action: "start",
      id: "task-owned",
      projectId: "allowed",
      text: "authorized",
    });
    await assert.rejects(
      engine.command({ action: "interrupt", taskId: "not-owned" }),
      /本桥接/,
    );
    callbacks.onApproval({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "owned", command: "test" },
    });
    const approval = emitted
      .filter((e) => e.payload.state === "approval")
      .at(-1).payload.approvalId;
    await engine.command({
      action: "approve",
      taskId: "task-owned",
      approvalId: approval,
      decision: "decline",
    });
    assert.deepEqual(responses, [{ id: 7, decision: "decline" }]);
    await assert.rejects(
      engine.command({
        action: "approve",
        taskId: "task-owned",
        approvalId: approval,
        decision: "accept",
      }),
      /过期/,
    );
  } finally {
    engine.close();
  }
});
