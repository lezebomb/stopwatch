import { mkdir, lstat, rename, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicJson, readJson } from "./atomic.mjs";
import { compareVersion, verifyManifest } from "./security.mjs";
import { fetchEnvelope, downloadVerified } from "./download.mjs";

function safeRelease(versions, target) {
  if (typeof target !== "string" || path.dirname(target) !== versions || !/^[\w.-]+$/.test(path.basename(target)))
    throw new Error("Release pointer is outside StopWatch versions");
  return target;
}

export async function activePortalRelease(root) {
  const versions = path.resolve(root, "versions");
  if (!(await lstat(versions)).isDirectory()) throw new Error("Unsafe StopWatch versions directory");
  const pointer = await readJson(path.join(root, "current.json"));
  if (typeof pointer?.release !== "string" || !/^[\w.-]+$/.test(pointer.release))
    throw new Error("Missing StopWatch release pointer");
  const target = safeRelease(versions, path.resolve(versions, pointer.release));
  if (!(await lstat(target)).isDirectory()) throw new Error("Unsafe current release directory");
  return target;
}

// This manager owns only the StopWatch release pointer, immutable release
// directories and its journal. The caller supplies the process controls.
export class PortalUpdateManager {
  constructor(root, { publicKey, manifestUrl, origin, extract, check, restart, health, ca }) {
    this.root = path.resolve(root);
    this.versions = path.join(this.root, "versions");
    this.pointer = path.join(this.root, "current.json");
    this.journal = path.join(this.root, "portal-update.json");
    Object.assign(this, { publicKey, manifestUrl, origin, extract, check, restart, health, ca });
  }
  safe(target) {
    return safeRelease(this.versions, target);
  }
  async current() {
    return activePortalRelease(this.root);
  }
  async point(target) {
    this.safe(target);
    if (!(await lstat(target)).isDirectory()) throw new Error("Unsafe release directory");
    await atomicJson(this.pointer, { release: path.basename(target) });
  }
  async discard(target) {
    if (!target || !/-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path.basename(target))) return;
    this.safe(target);
    try {
      if ((await lstat(target)).isDirectory()) await rm(target, { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("Could not reclaim an old StopWatch portal release");
    }
  }
  async rollback(state) {
    const previous = this.safe(state.pending.previous);
    const current = await this.current();
    if (current !== previous && current !== this.safe(state.pending.next))
      throw new Error("Current changed outside the pending update");
    await this.point(previous);
    await this.restart();
    await this.health(state.pending.old);
    await atomicJson(this.journal, { ...state, pending: null, failedSequence: state.pending.sequence });
    if (state.pending.next !== previous) await this.discard(state.pending.next);
  }
  async run() {
    const state = await readJson(this.journal, { highestSequence: 0, failedSequence: 0 });
    if (state.pending) await this.rollback(state);
    const saved = await readJson(this.journal, state);
    const previous = await this.current();
    const old = await readJson(path.join(previous, "delivery.json"));
    if (!old || old.origin !== this.origin || old.containsPrivateData !== false || !old.build)
      throw new Error("The trusted initial portal release is missing");
    const envelope = await fetchEnvelope(this.manifestUrl, { ca: this.ca });
    const manifest = verifyManifest(envelope, this.publicKey, { kind: "portal", portalOrigin: this.origin, allowLoopback: !!this.ca });
    if (compareVersion(manifest.version, old.version) <= 0) return { state: "up-to-date" };
    if (manifest.sequence <= Math.max(saved.highestSequence, saved.failedSequence)) return { state: "quarantined" };
    const next = this.safe(path.join(this.versions, `${manifest.version}-${manifest.buildId}-${randomUUID()}`));
    const temp = await mkdtemp(path.join(this.versions, ".incoming-"));
    try {
      const archive = await downloadVerified(manifest, path.join(temp, "portal.tar.gz"), { ca: this.ca });
      const staging = path.join(temp, "release");
      await mkdir(staging);
      await this.extract(archive, staging);
      const delivery = await readJson(path.join(staging, "delivery.json"));
      if (delivery?.version !== manifest.version || delivery.build !== manifest.buildId ||
          delivery.origin !== this.origin || delivery.containsPrivateData !== false)
        throw new Error("Portal archive identity mismatch");
      // Preflight uses temporary data; the candidate cannot touch the real DB
      // until its release pointer has been activated.
      await this.check(staging, delivery, path.join(temp, "data"));
      await rename(staging, next);
      const journal = { ...saved, pending: { previous, next, old, sequence: manifest.sequence } };
      await atomicJson(this.journal, journal);
      try {
        await this.point(next);
        await this.restart();
        await this.health(delivery);
        await atomicJson(this.journal, { highestSequence: manifest.sequence, failedSequence: 0, previous, pending: null });
      } catch (error) {
        await this.rollback(journal);
        throw error;
      }
      if (saved.previous !== previous && saved.previous !== next) await this.discard(saved.previous);
      return { state: "activated", version: manifest.version };
    } finally {
      // mkdtemp created this directory directly below our verified root.
      this.safe(temp);
      await rm(temp, { recursive: true, force: true });
    }
  }
}
