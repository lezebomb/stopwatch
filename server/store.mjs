import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomInt, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  defaultSettings,
  PHOTO_BUDGET,
  PHOTO_LIMIT,
} from "../shared/model.mjs";
export const digest = (x) => createHash("sha256").update(x).digest("hex");
export const secret = () => randomBytes(24).toString("base64url");
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(`${directory}/relay.sqlite`);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY, expires INTEGER, role TEXT);
      CREATE TABLE IF NOT EXISTS ticket_short(hash TEXT PRIMARY KEY,
        ticket_hash TEXT NOT NULL UNIQUE REFERENCES tickets(hash) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, id TEXT, role TEXT, expires INTEGER, revoked INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, type TEXT, payload TEXT, time INTEGER);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(type TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, value TEXT, done INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, name TEXT, bytes INTEGER, created INTEGER);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, time INTEGER, actor TEXT, action TEXT);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS device_controls(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)");
    const columns = this.db.prepare("PRAGMA table_info(commands)").all().map(c => c.name);
    if (!columns.includes("receipt")) this.db.exec("ALTER TABLE commands ADD COLUMN receipt TEXT");
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)")
      .run(JSON.stringify(defaultSettings));
  }
  pruneTickets(now = Date.now()) {
    return this.db.prepare("DELETE FROM tickets WHERE expires <= ?").run(now).changes;
  }
  ticket(role = "operator", now = Date.now()) {
    const code = secret();
    const hash = digest(code), expires = now + 120000;
    let manualCode;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneTickets(now);
      this.db.prepare("INSERT INTO tickets VALUES (?, ?, ?)").run(hash, expires, role);
      if (role === "operator" || role === "viewer") {
        const insert = this.db.prepare("INSERT OR IGNORE INTO ticket_short VALUES (?, ?)");
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = String(randomInt(1000000)).padStart(6, "0");
          if (insert.run(digest(candidate), hash).changes) {
            manualCode = candidate;
            break;
          }
        }
        if (!manualCode) throw new Error("无法生成可用配对码，请重试");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return manualCode ? { code, manualCode, expires } : { code, expires };
  }
  pair(code, now = Date.now(), expected = null) {
    const hash = digest(code);
    const ticketHash = expected === "browser" && /^\d{6}$/.test(code)
      ? this.db.prepare("SELECT ticket_hash FROM ticket_short WHERE hash=?").get(hash)?.ticket_hash
      : hash;
    if (!ticketHash) return null;
    const ticket = this.db
      .prepare(
        "DELETE FROM tickets WHERE hash=? AND expires>? AND (? IS NULL OR (?='browser' AND role IN ('operator','viewer')) OR role=?) RETURNING role",
      )
      .get(ticketHash, now, expected, expected, expected);
    if (!ticket) return null;
    const token = secret(),
      id = randomBytes(8).toString("hex");
    this.db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 0)")
      .run(digest(token), id, ticket.role, now + 30 * 86400000);
    this.audit(id, "paired");
    return { token, id, role: ticket.role };
  }
  session(token, now = Date.now()) {
    return this.db
      .prepare(
        "SELECT id,role FROM sessions WHERE hash=? AND expires>? AND revoked=0",
      )
      .get(digest(token), now);
  }
  touch(token, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE sessions SET expires=? WHERE hash=? AND revoked=0 AND expires>?",
      )
      .run(now + 30 * 86400000, digest(token), now);
  }
  revoke(id) {
    this.db.prepare("UPDATE sessions SET revoked=1 WHERE id=?").run(id);
    this.audit(id, "revoked");
    this.db.prepare("DELETE FROM device_controls WHERE id=?").run(id);
  }
  deviceControl(id, enabled) {
    if (typeof enabled === "boolean") this.db.prepare("INSERT OR REPLACE INTO device_controls VALUES (?,?)").run(id, enabled ? 1 : 0);
    return this.db.prepare("SELECT enabled FROM device_controls WHERE id=?").get(id)?.enabled === 1;
  }
  audit(actor, action) {
    this.db
      .prepare("INSERT INTO audit(time,actor,action) VALUES (?,?,?)")
      .run(Date.now(), actor, action);
    this.db.exec(
      "DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-2000 FROM audit)",
    );
  }
  settings(patch) {
    if (patch)
      this.db
        .prepare("UPDATE settings SET value=? WHERE id=1")
        .run(JSON.stringify({ ...this.settings(), ...patch }));
    return { ...defaultSettings, ...JSON.parse(
      this.db.prepare("SELECT value FROM settings WHERE id=1").get().value,
    ) };
  }
  event(event) {
    if (event.type === "commandStatus") {
      const receipt = this.commandStatus(event.payload) || this.receipt(event.payload.commandId);
      if (!receipt) return null;
      event = { ...event, payload: { ...receipt, mode: event.payload.mode } };
    }
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO events(id,type,payload,time) VALUES (?,?,?,?) RETURNING seq",
      )
      .get(event.id, event.type, JSON.stringify(event.payload), Date.now());
    if (!result) return null;
    if (event.type === "task")
      this.db
        .prepare("INSERT OR REPLACE INTO tasks VALUES (?,?)")
        .run(event.payload.id, JSON.stringify(event.payload));
    if (event.type === "quota" || event.type === "bridgeStatus")
      this.db
        .prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?)")
        .run(event.type, JSON.stringify(event.payload));
    this.db.exec(
      "DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq),0)-999 FROM events)",
    );
    return { ...event, seq: Number(result.seq), time: Date.now() };
  }
  events(after = 0) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 1000")
      .all(after)
      .map((row) => ({ v: 1, ...row, payload: JSON.parse(row.payload) }));
  }
  tasks() {
    return this.db
      .prepare("SELECT value FROM tasks")
      .all()
      .map((row) => JSON.parse(row.value));
  }
  snapshot(type) {
    const row = this.db
      .prepare("SELECT value FROM snapshots WHERE type=?")
      .get(type);
    return row ? JSON.parse(row.value) : null;
  }
  photos() {
    return this.db.prepare("SELECT * FROM photos ORDER BY created").all();
  }
  addPhoto(photo) {
    const photos = this.photos();
    if (
      photos.length >= PHOTO_LIMIT ||
      photos.reduce((n, p) => n + p.bytes, 0) + photo.bytes > PHOTO_BUDGET
    )
      throw new Error("照片容量已满，请先删除一些照片");
    this.db
      .prepare("INSERT INTO photos VALUES (?,?,?,?)")
      .run(photo.id, photo.name, photo.bytes, Date.now());
  }
  command(command) {
    const existing = this.db
      .prepare("SELECT value FROM commands WHERE id=?")
      .get(command.id);
    if (existing) {
      if (existing.value !== JSON.stringify(command))
        throw new Error("幂等键已用于其他命令");
      return false;
    }
    if (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE done=0")
        .get().count >= 128
    )
      throw new Error("离线队列已满，请等待桥接恢复");
    if (
      command.action === "start" &&
      this.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM tasks) + COUNT(*) AS count FROM commands WHERE done=0 AND json_extract(value, '$.action')='start'",
        )
        .get().count >= 100
    )
      throw new Error("MVP 最多保留 100 个会话");
    this.db
      .prepare("INSERT INTO commands(id,value,done) VALUES (?,?,0)")
      .run(command.id, JSON.stringify(command));
    this.commandStatus({ commandId: command.id, stage: "received", taskId: command.taskId || (command.action === "start" ? command.id : null) });
    return true;
  }
  savedCommand(id) {
    const row = this.db.prepare("SELECT value FROM commands WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  }
  receipt(id) {
    const row = this.db.prepare("SELECT receipt FROM commands WHERE id=?").get(id);
    return row?.receipt ? JSON.parse(row.receipt) : null;
  }
  receipts(actor) {
    return this.db.prepare("SELECT receipt FROM commands WHERE receipt IS NOT NULL AND (? IS NULL OR json_extract(value,'$.actor')=?) ORDER BY rowid DESC LIMIT 20")
      .all(actor || null, actor || null).map(row => JSON.parse(row.receipt));
  }
  commandStatus(update) {
    const rank = { received: 0, accepted: 1, executing: 2, uncertain: 3, succeeded: 4, failed: 4, interrupted: 4 };
    const command = typeof update.commandId === "string" && this.savedCommand(update.commandId);
    if (!Object.hasOwn(rank, update.stage) || !command) return;
    const previous = this.receipt(update.commandId);
    if (previous && (rank[previous.stage] === 4 || rank[update.stage] < rank[previous.stage] && !(previous.stage === "uncertain" && update.stage === "executing"))) return;
    const receipt = { commandId: update.commandId, action: command.action, ...(command.action === "approve" ? { decision: command.decision } : {}), stage: update.stage, taskId: update.taskId || previous?.taskId || null,
      message: typeof update.message === "string" ? update.message.slice(0, 512) : null, updated: Date.now() };
    this.db.prepare("UPDATE commands SET receipt=? WHERE id=?").run(JSON.stringify(receipt), update.commandId);
    return receipt;
  }
  pending() {
    return this.db
      .prepare("SELECT value FROM commands WHERE done=0")
      .all()
      .map((row) => JSON.parse(row.value));
  }
  ack(id) {
    this.db.prepare("UPDATE commands SET done=1 WHERE id=?").run(id);
    this.db.exec(
      "DELETE FROM commands WHERE done=1 AND rowid < (SELECT COALESCE(MAX(rowid),0)-1000 FROM commands)",
    );
  }
  close() {
    this.db.close();
  }
}
