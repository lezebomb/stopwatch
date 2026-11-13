import { WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockCodex } from "./mock.mjs";
export function connectBridge({
  url,
  token,
  directory = ".data",
  delay = 800,
  onStatus = () => {},
  engineFactory,
  mode = "mock",
}) {
  if (
    !/^ws:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) &&
    !url.startsWith("wss://")
  )
    throw new Error("非本地连接必须使用 WSS");
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(`${directory}/bridge.sqlite`);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,value TEXT);",
  );
  if (
    !db
      .prepare("PRAGMA table_info(seen)")
      .all()
      .some((c) => c.name === "status")
  )
    db.exec("ALTER TABLE seen ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
  let ws,
    stopped = false,
    retry,
    heartbeat,
    attempts = 0,
    authorizationBlocked = false,
    queue = Promise.resolve();
  let lastPong = 0;
  const send = (value) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const emit = (type, payload) => {
    const event = { v: 1, id: randomUUID(), type, payload };
    db.prepare("INSERT INTO outbox VALUES (?,?)").run(
      event.id,
      JSON.stringify(event),
    );
    if (type === "task")
      db.prepare("INSERT OR REPLACE INTO tasks VALUES (?,?)").run(
        payload.id,
        JSON.stringify(payload),
      );
    send({ type: "event", event });
  };
  const engineOptions = {
    emit,
    delay,
    tasks: db
      .prepare("SELECT value FROM tasks")
      .all()
      .map((r) => JSON.parse(r.value)),
  };
  const engine = engineFactory
    ? engineFactory(engineOptions)
    : new MockCodex(engineOptions);
  if (mode === "production" && !engineFactory)
    throw new Error("Production bridge requires a real authorized engine");
  engine.recover();
  const open = () => {
    if (stopped) return;
    ws = new WebSocket(`${url}/bridge`, {
      headers: { Authorization: `Bearer ${token}`, "X-StopWatch-Mode": mode },
      maxPayload: 512 * 1024,
    });
    ws.on("open", () => {
      attempts = 0;
      onStatus(true);
      lastPong = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 35000) return ws.terminate();
        ws.ping();
        send({ type: "heartbeat" });
      }, 10000);
      for (const row of db.prepare("SELECT value FROM outbox").all())
        send({ type: "event", event: JSON.parse(row.value) });
      engine.relayConnected?.();
      if (mode === "mock")
        emit("quota", {
          mode: "mock",
          primary: {
            usedPercent: 24,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 10800,
          },
          secondary: {
            usedPercent: 42,
            windowDurationMins: 10080,
            resetsAt: Math.floor(Date.now() / 1000) + 345600,
          },
        });
    });
    ws.on("pong", () => { lastPong = Date.now(); });
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "eventAck") {
          db.prepare("DELETE FROM outbox WHERE id=?").run(data.id);
          return;
        }
        if (data.type !== "command") return;
        const c = data.command;
        queue = queue
          .then(async () => {
            if (stopped) return;
            const seen = db
              .prepare("SELECT status FROM seen WHERE id=?")
              .get(c.id);
            if (seen) {
              if (seen.status === "processing")
                emit("commandStatus", {
                  commandId: c.id,
                  taskId: c.taskId || (c.action === "start" ? c.id : null), stage: "uncertain",
                  message:
                    "桥接在执行确认前重启；已避免重复执行，请核对会话结果",
                  mode,
                });
              send({ type: "ack", id: c.id });
              return;
            }
            db.prepare(
              "INSERT INTO seen(id,status) VALUES (?,'processing')",
            ).run(c.id);
            try {
              await engine.command(c);
              emit("commandStatus", { commandId: c.id, taskId: c.taskId || (c.action === "start" ? c.id : null), stage: "accepted", mode });
            } catch (error) {
              const uncertain = ["RPC_TIMEOUT", "RPC_DISCONNECTED"].includes(error.code);
              engine.commandFailed?.(c, error, uncertain);
              emit("commandStatus", { commandId: c.id, taskId: c.taskId || (c.action === "start" ? c.id : null), stage: uncertain ? "uncertain" : "failed", message: error.message, mode });
              emit("commandError", {
                commandId: c.id,
                message: error.message,
                mode,
              });
            }
            db.prepare("UPDATE seen SET status='done' WHERE id=?").run(c.id);
            send({ type: "ack", id: c.id });
          })
          .catch(() =>
            onStatus(false, { state: "bridge-error", online: false }),
          );
      } catch {
        ws.close(1008, "invalid protocol");
      }
    });
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => {
      if ([401, 403].includes(res.statusCode)) {
        authorizationBlocked = true;
        onStatus(false, { state: "revoked", online: false });
        engine.close();
      }
      res.resume();
      ws.terminate();
    });
    ws.on("close", (code) => {
      clearInterval(heartbeat);
      if (code === 4001 || code === 4002) {
        authorizationBlocked = true;
        engine.close();
      }
      onStatus(
        false,
        authorizationBlocked ? { state: "revoked", online: false } : {},
      );
      if (!stopped && !authorizationBlocked)
        retry = setTimeout(
          open,
          Math.min(15000, 500 * 2 ** Math.min(attempts++, 5)) +
            Math.random() * 250,
        );
    });
  };
  open();
  return {
    engine,
    disconnect: () => ws?.terminate(),
    close: () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      engine.close();
      ws?.terminate();
      queue.finally(() => setTimeout(() => db.close(), 100));
    },
  };
}
