import { readFile } from "node:fs/promises";
import path from "node:path";
import { PHOTO_BYTES } from "../shared/model.mjs";
import { digest } from "./store.mjs";
import release from "../release/config.json" with { type: "json" };

export const deviceHardware = release.hardware;

function usage(value) {
  if (!Number.isFinite(value?.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) {
    return null;
  }
  return {
    usedPercent: value.usedPercent,
    resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null,
    windowDurationMins: Number.isFinite(value.windowDurationMins) ? value.windowDurationMins : null,
  };
}

export function createDeviceSync(store, directory, bridgeOnline) {
  const hashes = new Map();
  const seen = new Map();
  const photoPath = id => path.join(directory, `${id}.rgb565`);
  async function photoBytes(id) {
    const data = await readFile(photoPath(id));
    if (data.length !== PHOTO_BYTES) throw new Error("Invalid device photo size");
    return data;
  }
  function present() {
    const now = Date.now();
    for (const [id, last] of seen) {
      if (now - last > 90000) seen.delete(id);
    }
    return seen.size > 0;
  }
  async function snapshot() {
    const entries = store.photos();
    const { defaultPhoto, slideshow, slideSeconds, border, brightness } = store.settings();
    const ids = new Set(entries.map(photo => photo.id));
    for (const cached of hashes.keys()) {
      if (!ids.has(cached)) hashes.delete(cached);
    }
    const photos = [];
    for (const photo of entries) {
      let sha256 = hashes.get(photo.id);
      if (!sha256) {
        sha256 = digest(await photoBytes(photo.id));
        hashes.set(photo.id, sha256);
      }
      photos.push({ id: photo.id, sha256, size: PHOTO_BYTES });
    }
    const tasks = store.tasks().filter(item => item.mode === "production");
    tasks.sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
    const task = tasks.find(item => ["thinking", "working", "testing", "approval"].includes(item.state)) || tasks[0];
    const bridge = store.snapshot("bridgeStatus");
    const online = bridgeOnline() && bridge?.mode === "production" && bridge?.online === true;
    const quota = online ? store.snapshot("quota") : null;
    return {
      schema: 1,
      hardware: deviceHardware,
      syncedAt: Date.now(),
      photos,
      cover: { defaultPhoto, slideshow, slideSeconds, border, brightness },
      codex: {
        online,
        task: task ? {
          id: task.id.slice(0, 64),
          state: task.state,
          title: String(task.title || "").slice(0, 150),
          project: String(task.project || "").slice(0, 60),
          updated: task.updated || task.created || null,
        } : null,
        quota: quota?.mode === "production" ? { primary: usage(quota.primary), secondary: usage(quota.secondary) } : null,
      },
    };
  }
  return {
    present,
    snapshot,
    markSeen(id) {
      present();
      seen.set(id, Date.now());
    },
    forget(id) { seen.delete(id); },
    async photo(id) {
      if (!store.photos().some(entry => entry.id === id)) return null;
      return photoBytes(id);
    },
  };
}
