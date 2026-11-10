import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import lock from "../miao.lock.json" with { type: "json" };
import stateMap from "../shared/miao-state.json" with { type: "json" };
import release from "../release/config.json" with { type: "json" };
import { validateManifest } from "../updates/security.mjs";

const source = path.resolve(".deps/miao");
export const miaoOutput = path.resolve(".deps/miao-pack");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-c", `safe.directory=${source.replaceAll("\\", "/")}`,
  ...(process.platform === "win32" ? ["-c", "http.sslBackend=openssl"] : []),
  "-C", source, ...args], { encoding: "utf8" }).trim();
const name = value => value.replaceAll("-", "_").toUpperCase();
async function available(file) { try { await access(file); return true; } catch { return false; } }

function cMetadata(meta) {
  const actions = Object.keys(meta.actions);
  const a = value => `MIAO_${name(value)}`;
  const rows = actions.map(key => {
    const item = meta.actions[key];
    return `static const miao_step_t steps_${name(key)}[] = {${item.frames.map((id, i) => `{${id},${item.ms[i]}}`).join(",")}};`;
  });
  rows.push(`enum { ${actions.map(a).join(",")}, MIAO_ACTION_COUNT };`);
  rows.push(`static const miao_action_t actions[] = {\n${actions.map(key => {
    const item = meta.actions[key];
    return ` [${a(key)}] = {steps_${name(key)}, ${item.frames.length}, ${item.repeat}, ${item.loop ? 1 : 0}, ${item.outro ? a(item.outro) : -1}},`;
  }).join("\n")}\n};`);
  rows.push(`static const miao_mapping_t mapping[SW_TASK_COUNT] = {${Object.entries(stateMap).map(([key, keys]) => `[SW_${name(key)}] = {${a(keys[0])}, ${keys[1] ? a(keys[1]) : -1}}`).join(",")}};`);
  const weights = list => list.map(({ action, weight }) => `{${a(action)},${Math.round(weight * 100)}}`).join(",");
  rows.push(`static const miao_weight_t idle_choices[] = {${weights(meta.micro)}};`);
  rows.push(`static const miao_weight_t touch_choices[] = {${weights(meta.touch)}};`);
  rows.push(`#define MIAO_WIDTH ${lock.width}\n#define MIAO_HEIGHT ${lock.height}\n#define MIAO_COUNT ${meta.count}\n#define MIAO_BUDGET ${lock.budgetBytes}`);
  rows.push(`#define MIAO_IDLE_MIN ${meta.idleMs[0]}\n#define MIAO_IDLE_MAX ${meta.idleMs[1]}\n#define MIAO_WASH_MIN ${meta.specialMs[0]}\n#define MIAO_WASH_MAX ${meta.specialMs[1]}\n#define MIAO_WASH_CHANCE ${Math.round(meta.washChance * 100)}\n#define MIAO_TAP_COOLDOWN ${meta.cooldown}`);
  return `/* Generated from ${lock.repo}/commit/${lock.commit} */\n#pragma once\n${rows.join("\n")}\n`;
}

export async function miaoAssets() {
  const marker = path.join(miaoOutput, "manifest.json");
  const cacheKey = digest(JSON.stringify({ lock, stateMap }) + await readFile(fileURLToPath(import.meta.url), "utf8"));
  if (await available(marker)) {
    const old = JSON.parse(await readFile(marker, "utf8"));
    if (old.cacheKey === cacheKey) {
      const cached = await Promise.all(["miao.pack", "idle.bin", "miao_data.h", "web.json"].map(f => readFile(path.join(miaoOutput, f)).catch(() => null)));
      const names = await readdir(path.join(miaoOutput, "web")).catch(() => []);
      if (cached.every(Boolean) && digest(cached[0]) === old.sha256 && digest(cached[1]) === old.fallbackSha256 &&
          Array.from({ length: old.frames }, (_, i) => `${i}.webp`).every(file => names.includes(file))) return old;
    }
  }
  if (!(await available(path.join(source, ".git")))) {
    await mkdir(source, { recursive: true });
    git("init");
    git("fetch", "--depth=1", lock.repo, lock.commit);
    git("checkout", "--detach", lock.commit);
  }
  const paths = ["pet/miaomiao/behavior.json", "pet/miaomiao/actions", "miaomiao.config.json"];
  if (git("rev-parse", "HEAD") !== lock.commit || git("status", "--porcelain", "--untracked-files=all", "--", ...paths))
    throw new Error("Miao checkout must match miao.lock.json with unmodified animation assets");
  const pet = path.join(source, "pet/miaomiao");
  const behavior = JSON.parse(await readFile(path.join(source, paths[0])));
  const config = JSON.parse(await readFile(path.join(source, paths[2])));
  const scale = config.globalDurationScale;
  const frames = [...new Set(Object.values(behavior.actions).flatMap(action => action.frames))];
  if (frames[0] !== behavior.actions.idle.frames[0]) throw new Error("Expected first frame to be idle");
  const files = (await readdir(path.join(pet, "actions"), { recursive: true })).map(f => f.replaceAll("\\", "/"));
  for (const f of files.filter(f => f.endsWith(".png")).sort()) if (!frames.includes(`actions/${f}`)) frames.push(`actions/${f}`);
  if (frames.length !== 70 || behavior.formatVersion !== 2 || !Number.isFinite(scale) || scale <= 0)
    throw new Error("Unexpected Miao source format or frame count");
  const meta = {
    count: frames.length, actions: {}, stateMap,
    idleMs: config.idlePauseRangeMs.map(ms => Math.round(ms * scale)),
    specialMs: behavior.events.idle.specialCheckIntervalMs.map(ms => Math.round(ms * scale)),
    micro: behavior.events.idle.microActions,
    touch: behavior.events.petOrHover.random.map((action, i) => ({ action, weight: behavior.events.petOrHover.weights[i] })),
    cooldown: config.triggerCooldownMs,
    washChance: behavior.events.idle.random.find(item => item.action === "wash-face").weight,
  };
  for (const [key, action] of Object.entries(behavior.actions)) {
    const ms = action.frames.map((_, i) => Math.round((action.frameDurationsMs?.[i] ?? action.frameDurationMs) * scale));
    if (ms.some(value => !Number.isInteger(value) || value < 1 || value > 65535)) throw new Error(`Invalid durations for ${key}`);
    meta.actions[key] = { frames: action.frames.map(f => frames.indexOf(f)), ms, loop: action.loop, repeat: action.repeatCount, outro: action.outroAction };
  }
  const web = path.join(miaoOutput, "web");
  await mkdir(web, { recursive: true });
  const { width, height } = lock, pixels = width * height;
  const header = Buffer.alloc(12 + frames.length * 8);
  header.write("MIA1");
  header.writeUInt16LE(width, 4); header.writeUInt16LE(height, 6);
  header.writeUInt16LE(frames.length, 8);
  const chunks = [header];
  let originalBytes = 0, resizedPngBytes = 0, webBytes = 0, offset = header.length;
  for (const [index, file] of frames.entries()) {
    if (!/^actions\/[a-z-]+\/frame-\d\d\.png$/.test(file)) throw new Error(`Invalid frame path ${file}`);
    const original = await readFile(path.join(pet, file));
    const image = sharp(original);
    const dimensions = await image.metadata();
    if (dimensions.width !== 192 || dimensions.height !== 208 || !dimensions.hasAlpha) throw new Error(`Invalid frame ${file}`);
    originalBytes += original.length;
    const raw = await image.clone().resize(width, height).ensureAlpha().raw().toBuffer();
    const pixels565 = Buffer.alloc(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      const [r, g, b, a] = raw.subarray(i * 4, i * 4 + 4);
      pixels565.writeUInt16LE(a ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3) : 0, i * 2);
      pixels565[pixels * 2 + i] = a;
    }
    if (!index) await writeFile(path.join(miaoOutput, "idle.bin"), pixels565);
    const compressed = deflateSync(pixels565, { level: 9 });
    header.writeUInt32LE(offset, 12 + index * 8);
    header.writeUInt32LE(compressed.length, 16 + index * 8);
    offset += compressed.length;
    chunks.push(compressed);
    resizedPngBytes += (await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()).length;
    const webp = await image.webp({ lossless: true }).toBuffer();
    webBytes += webp.length;
    await writeFile(path.join(web, `${index}.webp`), webp);
  }
  const pack = Buffer.concat(chunks);
  if (pack.length + pixels * 3 > lock.budgetBytes) throw new Error("Miao assets exceed firmware storage budget");
  const manifest = {
    schema: 1, kind: "system-resource", id: "miao", version: `1.${lock.commit.slice(0, 12)}`,
    source: lock.repo, commit: lock.commit, cacheKey, encoding: "MIA1/RGB565A8/deflate",
    width, height, frames: frames.length, bytes: pack.length, sha256: digest(pack),
    fallbackSha256: digest(await readFile(path.join(miaoOutput, "idle.bin"))),
    layoutSha256: digest(JSON.stringify(meta)), budgetBytes: lock.budgetBytes,
    rawFrameBytes: pixels * 3, originalBytes, resizedPngBytes, webBytes,
  };
  await writeFile(path.join(miaoOutput, "miao.pack"), pack);
  await writeFile(path.join(miaoOutput, "miao_data.h"), cMetadata(meta));
  await writeFile(path.join(miaoOutput, "web.json"), JSON.stringify({ ...meta, assetVersion: manifest.version }));
  await writeFile(marker, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function copyMiaoWeb(output, manifest) {
  const dir = path.join(output, "miao", manifest.version);
  await mkdir(dir, { recursive: true });
  await cp(path.join(miaoOutput, "web"), dir, { recursive: true });
  await cp(path.join(miaoOutput, "manifest.json"), path.join(dir, "manifest.json"));
}

export function miaoResourceCandidate(pack, version, sequence, url) {
  const files = [{ name: "miao.pack", size: pack.bytes, sha256: pack.sha256, url }];
  return validateManifest({
    schema: 1, kind: "resources", namespace: "system", channel: "stable",
    version, sequence, buildId: pack.commit.slice(0, 12), hardware: release.hardware,
    size: pack.bytes, sha256: digest(JSON.stringify(files)), url, files,
    compatibility: { dataSchema: release.dataSchema, miaoLayoutSha256: pack.layoutSha256 },
    publishedAt: new Date().toISOString(),
  }, { kind: "resources" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pack = await miaoAssets();
  const [mode, version, sequence, url] = process.argv.slice(2);
  const result = mode === "--candidate" ? miaoResourceCandidate(pack, version, Number(sequence), url) : pack;
  console.log(JSON.stringify(result, null, 2));
}
