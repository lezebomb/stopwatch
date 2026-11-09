import http from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import sharp from "sharp";
import QRCode from "qrcode";
import { Store, secret, digest } from "./store.mjs";
import {
  validEvent,
  PHOTO_BYTES,
  PHOTO_BUDGET,
  PHOTO_LIMIT,
} from "../shared/model.mjs";
const allowedCommands = ["start", "continue", "steer", "interrupt", "approve"];
const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};
function cookie(req) {
  return (
    /(?:^|;\s*)sw_session=([A-Za-z0-9_-]+)/.exec(
      req.headers.cookie || "",
    )?.[1] || ""
  );
}
async function body(req, max = 65536) {
  const chunks = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > max)
      throw Object.assign(new Error("请求过大"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function createRelay({
  directory = ".data",
  port = 8787,
  bridgeToken = secret(),
  webRoot = "dist",
} = {}) {
  const store = new Store(directory),
    sockets = new Set();
  let bridge = null,
    bridgeLastSeen = 0;
  const attempts = new Map();
  const authenticated = (req) => store.session(cookie(req));
  const send = (ws, value) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const broadcast = (value) => {
    for (const ws of sockets) send(ws, value);
  };
  const publish = (event) => {
    const saved = store.event(event);
    if (saved) broadcast({ type: "event", event: saved });
    return saved;
  };
  const online = () => !!bridge && Date.now() - bridgeLastSeen < 35000;
  const status = () => ({
    mode: "mock",
    bridgeOnline: online(),
    deviceOnline: false,
    deviceNote: "实物未连接",
    tasks: store.tasks(),
    quota: store.snapshot("quota"),
    settings: store.settings(),
    photos: store.photos(),
    photoBudget: PHOTO_BUDGET,
    photoLimit: PHOTO_LIMIT,
    sessions: store.db.prepare("SELECT id,role,revoked FROM sessions").all(),
    cursor: store.events().at(-1)?.seq || 0,
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      if (
        req.headers.host !== expectedHost &&
        req.headers.host !== `localhost:${server.address()?.port}`
      )
        return json(res, 403, { error: "不允许的 Host" });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`)
        return json(res, 403, { error: "不允许的来源" });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        origin !== `http://${req.headers.host}`
      )
        return json(res, 403, { error: "写入请求必须同源" });
      if (url.pathname === "/api/health")
        return json(res, 200, {
          ok: true,
          mode: "mock",
          bridgeOnline: online(),
        });
      if (url.pathname === "/api/pair" && req.method === "POST") {
        const key = req.socket.remoteAddress,
          now = Date.now();
        const attempt = attempts.get(key) || { count: 0, until: now + 60000 };
        if (attempt.until < now) {
          attempt.count = 0;
          attempt.until = now + 60000;
        }
        attempts.set(key, attempt);
        if (++attempt.count > 10)
          return json(res, 429, { error: "尝试过多，请一分钟后重试" });
        const data = JSON.parse((await body(req)).toString());
        if (typeof data.code !== "string" || data.code.length > 128)
          return json(res, 400, { error: "无效配对码" });
        const session = store.pair(data.code);
        if (!session)
          return json(res, 401, {
            error: "配对码已过期或已使用，请在电脑上重新生成",
          });
        res.setHeader(
          "Set-Cookie",
          `sw_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
        );
        return json(res, 200, { id: session.id, role: session.role });
      }
      if (url.pathname.startsWith("/api/")) {
        const session = authenticated(req);
        if (!session) return json(res, 401, { error: "请先配对" });
        if (req.method !== "GET" && session.role !== "operator")
          return json(res, 403, { error: "只读设备不可执行操作" });
        if (url.pathname === "/api/state" && req.method === "GET")
          return json(res, 200, { ...status(), session });
        if (url.pathname === "/api/events" && req.method === "GET") {
          const after = Number(url.searchParams.get("after") || 0);
          if (!Number.isSafeInteger(after) || after < 0)
            return json(res, 400, { error: "游标无效" });
          const events = store.events(after);
          return json(res, 200, {
            events,
            resync: after > 0 && events.length > 0 && events[0].seq > after + 1,
          });
        }
        if (url.pathname === "/api/tickets" && req.method === "POST") {
          const data = JSON.parse((await body(req)).toString());
          const ticket = store.ticket(
            data.role === "viewer" ? "viewer" : "operator",
          );
          const link = `http://${req.headers.host}/#pair=${ticket.code}`;
          store.audit(session.id, "ticket.created");
          return json(res, 200, {
            ...ticket,
            link,
            qr: await QRCode.toDataURL(link),
          });
        }
        if (url.pathname === "/api/revoke" && req.method === "POST") {
          const { id } = JSON.parse((await body(req)).toString());
          if (typeof id !== "string")
            return json(res, 400, { error: "无效设备" });
          store.revoke(id);
          for (const ws of sockets)
            if (ws.sessionId === id) ws.close(4001, "revoked");
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/settings" && req.method === "POST") {
          const data = JSON.parse((await body(req)).toString()),
            patch = {};
          if ("brightness" in data) {
            if (
              !Number.isInteger(data.brightness) ||
              data.brightness < 10 ||
              data.brightness > 80
            )
              throw new Error("亮度应在 10–80%");
            patch.brightness = data.brightness;
          }
          for (const key of ["slideshow", "firstRun"])
            if (typeof data[key] === "boolean") patch[key] = data[key];
          if ("slideSeconds" in data) {
            if (
              !Number.isInteger(data.slideSeconds) ||
              data.slideSeconds < 5 ||
              data.slideSeconds > 300
            )
              throw new Error("轮播间隔应为 5–300 秒");
            patch.slideSeconds = data.slideSeconds;
          }
          if (["mint", "gold", "none"].includes(data.border))
            patch.border = data.border;
          if (typeof data.eggMessage === "string")
            patch.eggMessage = data.eggMessage.slice(0, 150);
          if (
            typeof data.eggDate === "string" &&
            /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(data.eggDate)
          )
            patch.eggDate = data.eggDate;
          if (
            typeof data.defaultPhoto === "string" &&
            (/^builtin-[012]$/.test(data.defaultPhoto) ||
              store.photos().some((p) => p.id === data.defaultPhoto))
          )
            patch.defaultPhoto = data.defaultPhoto;
          store.settings(patch);
          store.audit(session.id, "settings.updated");
          publish({
            v: 1,
            id: randomUUID(),
            type: "settings",
            payload: store.settings(),
          });
          return json(res, 200, store.settings());
        }
        if (url.pathname === "/api/commands" && req.method === "POST") {
          const key = `command:${session.id}`,
            now = Date.now();
          let rate = attempts.get(key);
          if (!rate || rate.until < now) {
            rate = { count: 0, until: now + 60000 };
            attempts.set(key, rate);
          }
          if (++rate.count > 40)
            return json(res, 429, { error: "指令过于频繁，请稍后重试" });
          const data = JSON.parse((await body(req)).toString());
          if (
            !allowedCommands.includes(data.action) ||
            !/^[\w-]{8,80}$/.test(data.id || "")
          )
            return json(res, 400, { error: "无效命令" });
          if (
            ["start", "continue", "steer"].includes(data.action) &&
            (typeof data.text !== "string" ||
              !data.text.trim() ||
              data.text.length > 8000)
          )
            return json(res, 400, { error: "指令不能为空或超过 8000 字" });
          if (
            data.action !== "start" &&
            (typeof data.taskId !== "string" ||
              !store.tasks().some((t) => t.id === data.taskId))
          )
            return json(res, 404, { error: "任务不存在" });
          if (
            data.action === "approve" &&
            (!["accept", "decline"].includes(data.decision) ||
              typeof data.approvalId !== "string")
          )
            return json(res, 400, { error: "审批必须指定本次请求及决定" });
          const command = {
            v: 1,
            id: data.id,
            action: data.action,
            text: data.text,
            taskId: data.taskId,
            approvalId: data.approvalId,
            decision: data.decision,
            actor: session.id,
          };
          const added = store.command(command);
          if (added && bridge) send(bridge, { type: "command", command });
          store.audit(session.id, `command.${command.action}`);
          return json(res, 202, {
            queued: true,
            duplicate: !added,
            bridgeOnline: online(),
          });
        }
        if (url.pathname === "/api/photos" && req.method === "POST") {
          const input = await body(req, 8 * 1024 * 1024);
          const image = sharp(input, {
            limitInputPixels: 24000000,
            animated: false,
            failOn: "warning",
          })
            .rotate()
            .resize(466, 466, { fit: "cover" })
            .removeAlpha()
            .toColourspace("srgb");
          const raw = await image
            .clone()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const rgb565 = Buffer.alloc(PHOTO_BYTES);
          for (let i = 0; i < 466 * 466; i++)
            rgb565.writeUInt16LE(
              ((raw.data[i * 3] >> 3) << 11) |
                ((raw.data[i * 3 + 1] >> 2) << 5) |
                (raw.data[i * 3 + 2] >> 3),
              i * 2,
            );
          const jpg = await image.jpeg({ quality: 78 }).toBuffer();
          const id = randomUUID();
          const photo = {
            id,
            name: decodeURIComponent(
              req.headers["x-photo-name"] || "照片",
            ).slice(0, 100),
            bytes: jpg.length + rgb565.length,
          };
          store.addPhoto(photo);
          try {
            await writeFile(path.join(directory, `${id}.jpg`), jpg);
            await writeFile(path.join(directory, `${id}.rgb565`), rgb565);
          } catch (error) {
            store.db.prepare("DELETE FROM photos WHERE id=?").run(id);
            await Promise.allSettled(
              ["jpg", "rgb565"].map((ext) =>
                unlink(path.join(directory, `${id}.${ext}`)),
              ),
            );
            throw error;
          }
          store.audit(session.id, "photo.created");
          publish({
            v: 1,
            id: randomUUID(),
            type: "photos",
            payload: { photos: store.photos() },
          });
          return json(res, 201, photo);
        }
        const photoMatch =
          /^\/api\/photos\/([a-f0-9-]{36})(?:\.(jpg|rgb565))?$/.exec(
            url.pathname,
          );
        if (photoMatch) {
          const [, id, ext] = photoMatch;
          if (!store.photos().some((p) => p.id === id))
            return json(res, 404, { error: "照片不存在" });
          if (req.method === "DELETE") {
            await Promise.allSettled(
              ["jpg", "rgb565"].map((ext) =>
                unlink(path.join(directory, `${id}.${ext}`)),
              ),
            );
            store.db.prepare("DELETE FROM photos WHERE id=?").run(id);
            if (store.settings().defaultPhoto === id)
              store.settings({ defaultPhoto: "builtin-0" });
            publish({
              v: 1,
              id: randomUUID(),
              type: "photos",
              payload: { photos: store.photos() },
            });
            return json(res, 200, { ok: true });
          }
          if (req.method === "GET" && ext) {
            const image = await readFile(path.join(directory, `${id}.${ext}`));
            res.writeHead(200, {
              "Content-Type":
                ext === "jpg" ? "image/jpeg" : "application/octet-stream",
              "Cache-Control": "private, max-age=60",
            });
            return res.end(image);
          }
        }
        return json(res, 404, { error: "接口不存在" });
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "方法不支持" });
      const filename = ["/", "/simulator"].includes(url.pathname)
        ? "index.html"
        : url.pathname.slice(1);
      const root = path.resolve(webRoot),
        file = path.resolve(root, filename);
      if (!file.startsWith(root + path.sep))
        return json(res, 403, { error: "禁止访问" });
      const content = await readFile(file);
      res.writeHead(200, {
        "Content-Type": file.endsWith(".html")
          ? "text/html; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css"
            : "application/javascript",
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      json(res, error.status || (error.code === "ENOENT" ? 404 : 400), {
        error:
          error.code === "ENOENT"
            ? "文件不存在，请先 npm run build"
            : error.message,
      });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host,
      actualPort = server.address()?.port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host))
      return socket.destroy();
    if (req.url === "/bridge") {
      const candidate =
        req.headers.authorization?.replace(/^Bearer /, "") || "";
      if (
        !timingSafeEqual(
          Buffer.from(digest(candidate)),
          Buffer.from(digest(bridgeToken)),
        )
      )
        return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (bridge) bridge.close(4002, "replaced");
        bridge = ws;
        bridgeLastSeen = Date.now();
        broadcast({ type: "bridge", online: true });
        ws.on("message", (raw) => {
          try {
            const data = JSON.parse(raw.toString());
            bridgeLastSeen = Date.now();
            if (data.type === "heartbeat") return;
            if (data.type === "ack" && typeof data.id === "string")
              return store.ack(data.id);
            if (data.type === "event" && validEvent(data.event)) {
              if (
                data.event.type === "task" &&
                (typeof data.event.payload.id !== "string" ||
                  ![
                    "idle",
                    "thinking",
                    "working",
                    "testing",
                    "approval",
                    "completed",
                    "failed",
                    "interrupted",
                  ].includes(data.event.payload.state))
              )
                return ws.close(1008, "invalid task");
              publish(data.event);
              send(ws, { type: "eventAck", id: data.event.id });
            }
          } catch {
            ws.close(1008, "invalid protocol");
          }
        });
        ws.on("close", () => {
          if (bridge === ws) {
            bridge = null;
            broadcast({ type: "bridge", online: false });
          }
        });
        for (const command of store.pending())
          send(ws, { type: "command", command });
      });
      return;
    }
    const session = authenticated(req);
    if (
      !req.url.startsWith("/events?") ||
      !session ||
      req.headers.origin !== `http://${host}`
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionId = session.id;
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      send(ws, { type: "snapshot", state: status() });
      const after = Number(
        new URL(req.url, "http://localhost").searchParams.get("after") || 0,
      );
      for (const event of store.events(
        Number.isSafeInteger(after) && after >= 0 ? after : 0,
      ))
        send(ws, { type: "event", event });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (
        !store.db
          .prepare(
            "SELECT id FROM sessions WHERE id=? AND revoked=0 AND expires>?",
          )
          .get(ws.sessionId, Date.now())
      )
        ws.close(4001, "expired");
      else send(ws, { type: "bridge", online: online() });
    }
    if (bridge && !online()) bridge.terminate();
  }, 15000);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    store,
    bridgeToken,
    url: `http://127.0.0.1:${server.address().port}`,
    publish,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      wss.close();
      store.close();
    },
  };
}
