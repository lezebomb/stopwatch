import { createInterface } from "node:readline";
import { connectBridge } from "./client.mjs";
import { AppServerCodex } from "./real-engine.mjs";
const line = await new Promise((resolve) => {
  const reader = createInterface({ input: process.stdin });
  reader.once("line", (value) => {
    reader.close();
    resolve(value);
  });
});
const { config, token, root } = JSON.parse(line);
if (config.mode !== "production" || !config.executionAuthorized)
  throw new Error("Explicit production authorization required");
let relayOnline = false,
  codexOnline = false,
  busy = false;
const status = (detail = {}) =>
  process.send?.({
    ...detail,
    type: "status",
    state: relayOnline && codexOnline ? "online" : detail.state || "offline",
    online: relayOnline && codexOnline,
    busy,
  });
const bridge = connectBridge({
  url: config.relayUrl,
  token,
  directory: root,
  mode: "production",
  engineFactory: ({ emit, tasks }) =>
    new AppServerCodex({
      emit: (type, payload) => {
        if (type === "task") {
          busy = ["thinking", "working", "testing", "approval"].includes(
            payload.state,
          );
          status();
        }
        emit(type, payload);
      },
      tasks,
      workspaces: config.workspaces,
      executable: config.codex,
      onStatus: (s) => {
        codexOnline = s.online;
        emit("bridgeStatus", { ...s, mode: "production" });
        status(s);
      },
    }),
  onStatus: (online, detail = {}) => {
    relayOnline = online;
    status(detail);
  },
});
const heartbeat = setInterval(
  () => process.send?.({ type: "health", localReady: true }),
  5000,
);
process.send?.({ type: "health", localReady: true });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(heartbeat);
    bridge.close();
    setTimeout(() => process.exit(0), 200);
  });
process.on("message", (message) => {
  if (message?.type === "stop") {
    clearInterval(heartbeat);
    bridge.close();
    setTimeout(() => process.exit(0), 300);
  }
});
