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
  let ws,
    stopped = false,
    retry,
    heartbeat,
    attempts = 0;
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
  const engine = new MockCodex({
    emit,
    delay,
    tasks: db
      .prepare("SELECT value FROM tasks")
      .all()
      .map((r) => JSON.parse(r.value)),
  });
  engine.recover();
  const open = () => {
    if (stopped) return;
    ws = new WebSocket(`${url}/bridge`, {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: 65536,
    });
    ws.on("open", () => {
      attempts = 0;
      onStatus(true);
      heartbeat = setInterval(() => send({ type: "heartbeat" }), 10000);
      for (const row of db.prepare("SELECT value FROM outbox").all())
        send({ type: "event", event: JSON.parse(row.value) });
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
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "eventAck") {
          db.prepare("DELETE FROM outbox WHERE id=?").run(data.id);
          return;
        }
        if (data.type !== "command") return;
        const c = data.command;
        db.exec("BEGIN IMMEDIATE");
        try {
          const inserted = db
            .prepare("INSERT OR IGNORE INTO seen VALUES (?)")
            .run(c.id).changes;
          if (inserted) engine.command(c);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          emit("commandError", {
            commandId: c.id,
            message: error.message,
            mode: "mock",
          });
          db.prepare("INSERT OR IGNORE INTO seen VALUES (?)").run(c.id);
        }
        send({ type: "ack", id: c.id });
      } catch {
        ws.close(1008, "invalid protocol");
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(heartbeat);
      onStatus(false);
      if (!stopped)
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
      setTimeout(() => db.close(), 100);
    },
  };
}
