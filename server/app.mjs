import http from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import sharp from "sharp";
import QRCode from "qrcode";
import { Store, secret, digest } from "./store.mjs";
import { createDeviceSync, deviceHardware } from "./device-sync.mjs";
import {
  validEvent,
  PHOTO_BYTES,
  PHOTO_BUDGET,
  PHOTO_LIMIT,
} from "../shared/model.mjs";
const allowedCommands = ["start", "continue", "steer", "interrupt", "approve"];
function validEggDate(value) {
  if (typeof value !== "string" || !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [month, day] = value.split("-").map(Number);
  return day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const json = (res, code, body) => {
  const content = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  res.end(content);
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
  mode = "mock",
  publicOrigin = null,
  allowExecution = false,
} = {}) {
  if (!["mock", "production"].includes(mode))
    throw new Error("Unknown relay profile");
  if (
    mode === "production" &&
    (!publicOrigin ||
      new URL(publicOrigin).protocol !== "https:" ||
      new URL(publicOrigin).origin !== publicOrigin)
  )
    throw new Error(
      "Production requires a fixed HTTPS origin and trusted loopback TLS proxy",
    );
  const store = new Store(directory),
    sockets = new Set();
  let bridge = null,
    bridgeLastSeen = 0;
  const attempts = new Map();
  const authenticated = (req) => {
    const session = store.session(cookie(req));
    return ["operator", "viewer"].includes(session?.role) ? session : null;
  };
  const originFor = (req) =>
    mode === "production" ? publicOrigin : `http://${req.headers.host}`;
  const hostAllowed = (req) =>
    mode === "production"
      ? req.headers.host === new URL(publicOrigin).host &&
        req.headers["x-forwarded-proto"] === "https"
      : [
          `127.0.0.1:${server.address()?.port}`,
          `localhost:${server.address()?.port}`,
        ].includes(req.headers.host);
  const sessionCookie = (token) =>
    `sw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${mode === "production" ? "; Secure" : ""}`;
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
  const deviceSync = createDeviceSync(store, directory, online);
  const status = () => ({
    mode,
    executionEnabled: mode === "production" && allowExecution,
    bridgeOnline: online(),
    deviceOnline: deviceSync.present(),
    deviceNote: deviceSync.present() ? "挂件最近已同步" : "暂无在线挂件",
    tasks: store.tasks(),
    quota: store.snapshot("quota"),
    codex: store.snapshot("bridgeStatus"),
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
      if (!hostAllowed(req)) return json(res, 403, { error: "不允许的 Host" });
      const origin = req.headers.origin;
      if (origin && origin !== originFor(req))
        return json(res, 403, { error: "不允许的来源" });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        origin !== originFor(req) &&
        !["/api/bridge/enroll", "/api/bridge/revoke-self", "/api/device/enroll"].includes(
          url.pathname,
        )
      )
        return json(res, 403, { error: "写入请求必须同源" });
      if (url.pathname === "/api/health")
        return json(res, 200, {
          ok: true,
          mode,
          bridgeOnline: online(),
        });
      if (url.pathname === "/api/bridge/revoke-self" && req.method === "POST") {
        const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
        const enrolled = store.session(token);
        if (enrolled?.role !== "bridge")
          return json(res, 401, { error: "有效电脑授权必需" });
        store.revoke(enrolled.id);
        if (bridge?.sessionId === enrolled.id) bridge.close(4001, "revoked");
        return json(res, 200, { revoked: true });
      }
      if (
        ["/api/pair", "/api/bridge/enroll", "/api/device/enroll"].includes(url.pathname) &&
        req.method === "POST"
      ) {
        const deviceEnrollment = url.pathname === "/api/device/enroll";
        if (deviceEnrollment && mode !== "production")
          return json(res, 404, { error: "当前模式不提供挂件同步" });
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
        const enrollment = url.pathname === "/api/bridge/enroll";
        if (deviceEnrollment && data.hardware !== deviceHardware)
          return json(res, 400, { error: "设备型号不匹配" });
        const session = store.pair(
          data.code,
          Date.now(),
          deviceEnrollment ? "device" : enrollment ? "bridge" : "browser",
        );
        if (!session)
          return json(res, 401, {
            error: "配对码已过期或已使用，请在电脑上重新生成",
          });
        if (deviceEnrollment) {
          store.audit(session.id, "device.enrolled");
          return json(res, 200, { deviceId: session.id, token: session.token });
        }
        if (enrollment) {
          store.audit(session.id, "bridge.enrolled");
          return json(res, 200, {
            bridgeId: session.id,
            token: session.token,
            mode,
          });
        }
        res.setHeader("Set-Cookie", sessionCookie(session.token));
        return json(res, 200, { id: session.id, role: session.role });
      }
      const devicePhoto = /^\/api\/device\/photos\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (url.pathname === "/api/device/sync" || devicePhoto) {
        if (mode !== "production" || req.method !== "GET")
          return json(res, 404, { error: "接口不存在" });
        const token = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || "")?.[1];
        const device = token && store.session(token);
        if (device?.role !== "device")
          return json(res, 401, { error: "需要有效的挂件授权" });
        try {
          if (!devicePhoto) {
            const snapshot = await deviceSync.snapshot();
            if (!store.session(token)) return json(res, 401, { error: "挂件授权已失效" });
            store.touch(token);
            deviceSync.markSeen(device.id);
            return json(res, 200, snapshot);
          }
          const data = await deviceSync.photo(devicePhoto[1]);
          if (!data) return json(res, 404, { error: "照片不存在" });
          if (!store.session(token)) return json(res, 401, { error: "挂件授权已失效" });
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "private, no-store" });
          return res.end(data);
        } catch {
          return json(res, 503, { error: "相册暂时不可用，请稍后同步" });
        }
      }
      if (url.pathname.startsWith("/api/")) {
        const session = authenticated(req);
        if (!session) return json(res, 401, { error: "请先配对" });
        store.touch(cookie(req));
        res.setHeader("Set-Cookie", sessionCookie(cookie(req)));
        if (req.method !== "GET" && session.role !== "operator")
          return json(res, 403, { error: "只读设备不可执行操作" });
        if (url.pathname === "/api/bridge/tickets" && req.method === "POST") {
          const ticket = store.ticket("bridge");
          store.audit(session.id, "bridge.ticket.created");
          return json(res, 200, ticket);
        }
        if (url.pathname === "/api/device/tickets" && req.method === "POST" && mode === "production") {
          const ticket = store.ticket("device");
          store.audit(session.id, "device.ticket.created");
          return json(res, 200, ticket);
        }
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
          const link = `${originFor(req)}/#pair=${ticket.code}`;
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
          deviceSync.forget(id);
          if (bridge?.sessionId === id) bridge.close(4001, "revoked");
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
          if (["photo", "smart", "endurance"].includes(data.displayMode))
            patch.displayMode = data.displayMode;
          if (Number.isInteger(data.sleepAfter) && (data.sleepAfter === 0 || (data.sleepAfter >= 30 && data.sleepAfter <= 3600)))
            patch.sleepAfter = data.sleepAfter;
          if (Number.isInteger(data.utcOffset) && data.utcOffset >= -720 && data.utcOffset <= 840)
            patch.utcOffset = data.utcOffset;
          const previous = store.settings();
          if (data.eggPhoto === null || (typeof data.eggPhoto === "string" && store.photos().some(p => p.id === data.eggPhoto)))
            patch.eggPhoto = data.eggPhoto;
          if (typeof data.eggMessage === "string")
            patch.eggMessage = data.eggMessage.slice(0, 150);
          if (validEggDate(data.eggDate))
            patch.eggDate = data.eggDate;
          if (
            typeof data.defaultPhoto === "string" &&
            (/^builtin-[012]$/.test(data.defaultPhoto) ||
              store.photos().some((p) => p.id === data.defaultPhoto))
          )
            patch.defaultPhoto = data.defaultPhoto;
          const hidden = "eggPhoto" in patch ? patch.eggPhoto : previous.eggPhoto;
          if (hidden && (patch.defaultPhoto ?? previous.defaultPhoto) === hidden)
            patch.defaultPhoto = "builtin-0";
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
          if (mode === "production" && !allowExecution)
            return json(res, 503, {
              error: "真实执行尚未由维护者启用；演示与生产权限保持隔离",
            });
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
            projectId:
              typeof data.projectId === "string" ? data.projectId : undefined,
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
          try {
            await writeFile(path.join(directory, `${id}.jpg`), jpg);
            await writeFile(path.join(directory, `${id}.rgb565`), rgb565);
            store.addPhoto(photo);
          } catch (error) {
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
            store.db.exec("BEGIN IMMEDIATE");
            try {
              store.db.prepare("DELETE FROM photos WHERE id=?").run(id);
              const { defaultPhoto, eggPhoto } = store.settings();
              const patch = {};
              if (defaultPhoto === id) patch.defaultPhoto = "builtin-0";
              if (eggPhoto === id) patch.eggPhoto = null;
              if (Object.keys(patch).length) store.settings(patch);
              store.db.exec("COMMIT");
            } catch (error) {
              store.db.exec("ROLLBACK");
              throw error;
            }
            await Promise.allSettled(
              ["jpg", "rgb565"].map((ext) =>
                unlink(path.join(directory, `${id}.${ext}`)),
              ),
            );
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
        : ["/setup", "/setup/"].includes(url.pathname)
          ? "setup/index.html"
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
            : file.endsWith(".webp") ? "image/webp"
            : file.endsWith(".json") ? "application/json"
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
    const host = req.headers.host;
    if (!hostAllowed(req)) return socket.destroy();
    if (req.url === "/bridge") {
      const candidate =
        req.headers.authorization?.replace(/^Bearer /, "") || "";
      const enrolled = store.session(candidate);
      const validSession = enrolled?.role === "bridge";
      const validLegacy =
        mode === "mock" &&
        timingSafeEqual(
          Buffer.from(digest(candidate)),
          Buffer.from(digest(bridgeToken)),
        );
      if (
        (req.headers["x-stopwatch-mode"] || "mock") !== mode ||
        (!validSession && !validLegacy)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (bridge) bridge.close(4002, "replaced");
        bridge = ws;
        ws.sessionId = enrolled?.id;
        ws.credential = validSession ? candidate : null;
        bridgeLastSeen = Date.now();
        broadcast({ type: "bridge", online: true });
        ws.on("message", (raw) => {
          try {
            const data = JSON.parse(raw.toString());
            bridgeLastSeen = Date.now();
            if (data.type === "heartbeat") {
              if (ws.credential) {
                if (!store.session(ws.credential))
                  return ws.close(4001, "revoked");
                store.touch(ws.credential);
              }
              return;
            }
            if (data.type === "ack" && typeof data.id === "string")
              return store.ack(data.id);
            if (data.type === "event" && validEvent(data.event)) {
              if (
                ["task", "quota", "bridgeStatus", "commandError"].includes(
                  data.event.type,
                ) &&
                data.event.payload.mode !== mode
              )
                return ws.close(1008, "profile mismatch");
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
      req.headers.origin !== originFor(req)
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
      else send(ws, { type: "bridge", online: online(), deviceOnline: deviceSync.present() });
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
