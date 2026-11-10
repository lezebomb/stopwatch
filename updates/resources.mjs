import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicJson, readJson } from "./atomic.mjs";
import { verifyManifest, sha256 } from "./security.mjs";
import { downloadVerified } from "./download.mjs";
export class ResourceStore {
  constructor(root, { budget = 6 * 1024 * 1024 } = {}) {
    this.root = root;
    this.budget = budget;
  }
  async active() {
    return await readJson(path.join(this.root, "active.json"), {
      version: "0.0.0",
      highestSequence: 0,
      files: [],
    });
  }
  async apply(envelope, key, options = {}) {
    await mkdir(path.join(this.root, "objects"), { recursive: true });
    const old = await this.active();
    const m = verifyManifest(envelope, key, {
      kind: "resources",
      currentVersion: old.version,
      highestSequence: old.highestSequence,
      allowLoopback: !!options.ca,
    });
    if (sha256(Buffer.from(JSON.stringify(m.files))) !== m.sha256)
      throw new Error("Resource list digest mismatch");
    const names = new Set();
    let bytes = 0;
    for (const file of m.files) {
      const miao = file.name === "miao.pack" && file.size <= 950000 &&
        /^[a-f0-9]{64}$/.test(m.compatibility?.miaoLayoutSha256 || "");
      if (
        (!miao && !/^[A-Za-z0-9_-]{1,40}\.(rgb|jpg|png|wav|json)$/.test(file.name)) ||
        names.has(file.name) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        file.size > 1024 * 1024 ||
        new URL(file.url).protocol !== "https:"
      )
        throw new Error("Unsafe resource entry");
      names.add(file.name);
      bytes += file.size;
    }
    if (bytes !== m.size) throw new Error("Resource byte total mismatch");
    let used = 0;
    const existing = new Set(await readdir(path.join(this.root, "objects")));
    for (const file of existing)
      used += (await stat(path.join(this.root, "objects", file))).size;
    const incoming = m.files
      .filter((f) => !existing.has(f.sha256))
      .reduce((n, f) => n + f.size, 0);
    if (used + incoming > this.budget)
      throw new Error(
        "Insufficient copy-on-write capacity; active assets preserved",
      );
    for (const file of m.files) {
      const target = path.join(this.root, "objects", file.sha256);
      if (existing.has(file.sha256)) {
        if (sha256(await readFile(target)) !== file.sha256)
          throw new Error("Existing resource corrupt");
      } else await downloadVerified(file, target, options);
    }
    if (options.failpoint === "before-commit")
      throw new Error("Simulated power loss before pointer commit");
    await atomicJson(path.join(this.root, "previous.json"), old);
    await atomicJson(path.join(this.root, "active.json"), {
      version: m.version,
      highestSequence: m.sequence,
      namespace: "system",
      files: m.files,
    });
    return await this.active();
  }
  async health() {
    const current = await this.active();
    for (const file of current.files) {
      try {
        if (
          sha256(
            await readFile(path.join(this.root, "objects", file.sha256)),
          ) !== file.sha256
        )
          throw new Error("Corrupt object");
      } catch {
        const previous = await readJson(path.join(this.root, "previous.json"));
        if (!previous) throw new Error("No recoverable resource generation");
        await atomicJson(path.join(this.root, "active.json"), previous);
        return { ok: false, restored: true };
      }
    }
    return { ok: true, restored: false };
  }
  async collect() {
    const active = await this.active(),
      previous = await readJson(path.join(this.root, "previous.json"), {
        files: [],
      });
    const keep = new Set(
      [...active.files, ...previous.files].map((f) => f.sha256),
    );
    for (const name of await readdir(path.join(this.root, "objects")))
      if (/^[a-f0-9]{64}$/.test(name) && !keep.has(name))
        await unlink(path.join(this.root, "objects", name));
  }
}
