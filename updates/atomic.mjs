import { open, rename, readFile, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function atomicJson(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, filename);
        break;
      } catch (e) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(e.code))
          throw e;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
export async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(
      (await readFile(filename, "utf8")).replace(/^\uFEFF/, ""),
    );
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export class BootSlots {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "boot.json");
  }
  async state() {
    return await readJson(this.file, {
      active: "A",
      valid: "A",
      pending: null,
      attempted: false,
      highestSequence: 0,
    });
  }
  async stage(manifest, binary) {
    const s = await this.state();
    if (s.pending) throw new Error("Unconfirmed boot");
    const slot = s.active === "A" ? "B" : "A";
    await mkdir(this.directory, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(binary, path.join(this.directory, `${slot}.bin`));
    await atomicJson(this.file, {
      ...s,
      pending: slot,
      attempted: false,
      candidate: manifest,
    });
    return slot;
  }
  async boot() {
    let s = await this.state();
    if (s.pending && s.attempted) {
      s = {
        ...s,
        active: s.valid,
        pending: null,
        attempted: false,
        lastResult: "rolled-back",
        candidate: null,
      };
    } else if (s.pending) {
      s = {
        ...s,
        active: s.pending,
        attempted: true,
        lastResult: "pending-health",
      };
    }
    await atomicJson(this.file, s);
    return s;
  }
  async confirm({ ui, storage, audio, networkTask }) {
    const s = await this.state();
    if (!s.pending || ![ui, storage, audio, networkTask].every(Boolean))
      throw new Error("Health check incomplete");
    await atomicJson(this.file, {
      ...s,
      valid: s.active,
      pending: null,
      attempted: false,
      lastResult: "healthy",
      highestSequence: s.candidate.sequence,
      version: s.candidate.version,
      candidate: null,
    });
  }
}
