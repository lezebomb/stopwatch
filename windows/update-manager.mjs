import { mkdir, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fetchEnvelope, downloadVerified } from "../updates/download.mjs";
import { compareVersion, verifyManifest, sha256 } from "../updates/security.mjs";
import { atomicJson, readJson } from "../updates/atomic.mjs";
export class BridgeUpdateManager {
  constructor(
    root,
    { publicKey, manifestUrl, currentVersion = "0.2.0", ca } = {},
  ) {
    this.root = root;
    this.publicKey = publicKey;
    this.manifestUrl = manifestUrl;
    this.currentVersion = currentVersion;
    this.ca = ca;
  }
  async state() {
    return await readJson(path.join(this.root, "app-state.json"), {
      active: null,
      previous: null,
      pending: null,
      attempted: false,
      highestSequence: 0,
      currentVersion: this.currentVersion,
    });
  }
  async check() {
    if (!this.publicKey || !this.manifestUrl) return { state: "unconfigured" };
    const current = await this.state();
    if (current.pending) return { state: "pending" };
    const envelope = await fetchEnvelope(this.manifestUrl, { ca: this.ca });
    const m = verifyManifest(envelope, this.publicKey, {
      kind: "bridge",
      allowLoopback: !!this.ca,
    });
    if (compareVersion(m.version, current.currentVersion) <= 0)
      return { state: "up-to-date", version: current.currentVersion };
    if (m.sequence <= Math.max(current.highestSequence, current.failedSequence || 0))
      throw new Error("Update sequence replay");
    const directory = path.join(this.root, "apps", `${m.version}-${m.buildId}`);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "bridge.mjs");
    await downloadVerified(m, file, { ca: this.ca });
    await atomicJson(path.join(directory, "verified.json"), {
      manifest: m,
      envelope,
    });
    await atomicJson(path.join(this.root, "app-state.json"), {
      ...current,
      previous: current.active,
      pending: {
        file,
        version: m.version,
        sequence: m.sequence,
        hash: m.sha256,
      },
      attempted: false,
    });
    return { state: "staged", version: m.version };
  }
  async selectForBoot() {
    let s = await this.state();
    if (s.pending && s.attempted) {
      s = {
        ...s,
        active: s.previous,
        pending: null,
        attempted: false,
        lastResult: "rolled-back",
        failedSequence: s.pending.sequence,
      };
      await atomicJson(path.join(this.root, "app-state.json"), s);
    } else if (s.pending) {
      let valid = false;
      try {
        valid = sha256(await readFile(s.pending.file)) === s.pending.hash;
      } catch {}
      if (!valid) {
        s = {
          ...s,
          active: s.previous,
          failedSequence: s.pending.sequence,
          pending: null,
          attempted: false,
          lastResult: "rolled-back",
          detail: "staged file damaged",
        };
        await atomicJson(path.join(this.root, "app-state.json"), s);
        return s;
      }
      s = {
        ...s,
        active: s.pending.file,
        attempted: true,
        lastResult: "pending-health",
      };
      await atomicJson(path.join(this.root, "app-state.json"), s);
    }
    return s;
  }
  async healthy() {
    const s = await this.state();
    if (!s.pending || !s.attempted) return;
    await atomicJson(path.join(this.root, "app-state.json"), {
      ...s,
      currentVersion: s.pending.version,
      highestSequence: s.pending.sequence,
      pending: null,
      attempted: false,
      lastResult: "healthy",
    });
  }
}
