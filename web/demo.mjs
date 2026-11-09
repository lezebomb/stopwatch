import { MockCodex } from "../bridge/mock.mjs";
import {
  defaultSettings,
  PHOTO_BUDGET,
  PHOTO_LIMIT,
} from "../shared/model.mjs";
import QRCode from "qrcode";
export async function installDemo() {
  const prefix = "sw-isolated-demo-v2";
  let data;
  try {
    data = JSON.parse(localStorage.getItem(prefix));
  } catch {}
  data ||= {
    settings: { ...defaultSettings },
    tasks: [],
    events: [],
    photos: [],
    cursor: 0,
  };
  const listeners = new Set(),
    images = new Map();
  const persist = () =>
    localStorage.setItem(prefix, JSON.stringify({ ...data, photos: [] }));
  const emit = (type, payload) => {
    const event = {
      v: 1,
      id: crypto.randomUUID(),
      type,
      payload,
      seq: ++data.cursor,
      time: Date.now(),
    };
    data.events = [...data.events, event].slice(-100);
    if (type === "task")
      data.tasks = data.tasks
        .filter((t) => t.id !== payload.id)
        .concat(payload);
    if (type === "quota") data.quota = payload;
    persist();
    for (const socket of listeners) socket.emit({ type: "event", event });
  };
  const engine = new MockCodex({ emit, tasks: data.tasks, delay: 800 });
  engine.recover();
  const snapshot = () => ({
    ...data,
    mode: "mock",
    bridgeOnline: true,
    deviceOnline: false,
    session: { id: "demo-browser", role: "operator" },
    sessions: [{ id: "demo-browser", role: "operator", revoked: 0 }],
    isolatedDemo: true,
    updates: { current: "0.2.0", latest: null, state: "mock-only" },
  });
  const response = (object, status = 200) =>
    new Response(JSON.stringify(object), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
      location.href,
    );
    const match = /\/api\/(.*)/.exec(url.pathname);
    if (!match) {
      if (url.origin !== location.origin)
        throw new Error("演示环境禁止外部请求");
      return realFetch(input, options);
    }
    const route = match[1],
      body =
        typeof options.body === "string"
          ? JSON.parse(options.body || "{}")
          : {};
    if (route === "state") return response(snapshot());
    if (route === "pair")
      return response({ id: "demo-browser", role: "operator" });
    if (route === "events")
      return response({
        events: data.events.filter(
          (e) => e.seq > Number(url.searchParams.get("after") || 0),
        ),
      });
    if (route === "commands") {
      try {
        engine.command(body);
        return response({ queued: true, bridgeOnline: true }, 202);
      } catch (e) {
        return response({ error: e.message }, 400);
      }
    }
    if (route === "settings") {
      data.settings = { ...data.settings, ...body };
      persist();
      emit("settings", data.settings);
      return response(data.settings);
    }
    if (route === "tickets") {
      const link = new URL("#demo-only", location.href).href;
      return response({
        link,
        qr: await QRCode.toDataURL(link),
        expires: Date.now() + 120000,
      });
    }
    if (route === "revoke") return response({ ok: true, demoOnly: true });
    if (route === "updates/check") {
      emit("update", {
        mode: "mock",
        state: "up-to-date",
        current: "0.2.0",
        latest: "0.2.0",
      });
      return response({ mode: "mock", state: "up-to-date" });
    }
    if (route === "photos" && options.method === "POST") {
      if (
        !(options.body instanceof Blob) ||
        options.body.size > 8 * 1024 * 1024
      )
        return response({ error: "演示图片上限 8MiB" }, 400);
      const bitmap = await createImageBitmap(options.body);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 466;
      const context = canvas.getContext("2d");
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        466,
        466,
      );
      bitmap.close();
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.78),
      );
      const bytes = blob.size + 434312;
      if (
        data.photos.length >= PHOTO_LIMIT ||
        data.photos.reduce((n, p) => n + p.bytes, 0) + bytes > PHOTO_BUDGET
      )
        return response({ error: "照片容量已满" }, 400);
      const photo = {
        id: crypto.randomUUID(),
        name: decodeURIComponent(
          options.headers?.["X-Photo-Name"] || "演示照片",
        ),
        bytes,
      };
      images.set(photo.id, URL.createObjectURL(blob));
      data.photos.push(photo);
      emit("photos", { photos: data.photos });
      return response(photo, 201);
    }
    const photo = /^photos\/([a-f0-9-]{36})/.exec(route);
    if (photo && options.method === "DELETE") {
      data.photos = data.photos.filter((p) => p.id !== photo[1]);
      URL.revokeObjectURL(images.get(photo[1]));
      images.delete(photo[1]);
      emit("photos", { photos: data.photos });
      return response({ ok: true });
    }
    return response({ error: "隔离演示没有此生产能力" }, 404);
  };
  class DemoSocket {
    constructor() {
      this.readyState = 0;
      listeners.add(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.emit({ type: "snapshot", state: snapshot() });
        for (const event of data.events) this.emit({ type: "event", event });
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
      }, 20);
    }
    emit(value) {
      if (this.readyState === 1)
        this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {
      this.readyState = 3;
      listeners.delete(this);
      this.onclose?.({ code: 1000 });
    }
  }
  globalThis.WebSocket = DemoSocket;
  return {
    photoUrl: (id) =>
      images.get(id) || new URL("photos/0.jpg", import.meta.url).href,
  };
}
