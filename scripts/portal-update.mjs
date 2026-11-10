import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PortalUpdateManager } from "../updates/portal.mjs";
import config from "../release/config.json" with { type: "json" };

const exec = promisify(execFile);
const { STOPWATCH_HOME, STOPWATCH_PUBLIC_ORIGIN, PORT } = process.env;
if (process.platform !== "linux" || process.arch !== "x64" || process.versions.node.split(".")[0] !== "24" ||
    !config.productionOrigin) throw new Error("Production portal requires Linux x64 / Node 24 and a reviewed origin");
const origin = new URL(config.productionOrigin);
const port = Number(PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid StopWatch loopback port");

function readLocal(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: route, timeout: 1500,
      headers: { Host: origin.host, "X-Forwarded-Proto": "https" } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        data += chunk;
        if (data.length > 8192) req.destroy(new Error("Oversize local health response"));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error("Local health HTTP error");
          resolve(JSON.parse(data));
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Local health timeout")));
    req.on("error", reject);
  });
}
async function health(port, expected) {
  for (let i = 0; i < 12; i++) {
    try {
      const [relay, web] = await Promise.all([readLocal(port, "/api/health"), readLocal(port, "/version.json")]);
      if (relay.ok && relay.mode === "production" && web.mode === "production" && web.build === expected.build && web.version === expected.version) return;
    } catch {}
    await wait(500);
  }
  throw new Error("StopWatch portal did not report the expected build");
}

async function check(directory, expected, scratchData) {
  const child = spawn(process.execPath, ["server/main.mjs"], {
    cwd: directory,
    env: { ...process.env, PORT: "0", STOPWATCH_MODE: "production", STOPWATCH_ENABLE_EXECUTION: "0",
      STOPWATCH_PUBLIC_ORIGIN: origin.origin,
      STOPWATCH_WEB_ROOT: path.join(directory, "dist"), STOPWATCH_DATA_DIR: scratchData },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  let started = "";
  try {
    const testPort = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Portal preflight startup timed out")), 8000);
      closed.then(() => { clearTimeout(timeout); reject(new Error("Portal preflight exited")); });
      child.on("error", reject);
      child.stdout.on("data", bytes => {
        started = (started + bytes).slice(-1024);
        const match = /relay: http:\/\/127\.0\.0\.1:(\d+)\r?\n/.exec(started);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    await health(testPort, expected);
  } finally {
    child.kill();
    const kill = setTimeout(() => child.kill("SIGKILL"), 2500).unref();
    await closed;
    clearTimeout(kill);
  }
}

if (process.argv[2] === "--check") {
  const directory = await realpath(process.argv[3]);
  const expected = JSON.parse(await readFile(path.join(directory, "delivery.json"), "utf8"));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "sw-portal-check-"));
  try {
    await check(directory, expected, scratch);
    console.log(`Production portal package started successfully (${expected.version})`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  process.exit(0);
}

// flock in the user service releases its lock even if the updater is killed.
if (process.argv[2] !== "--apply" || process.argv[3] !== "--locked" || !path.isAbsolute(STOPWATCH_HOME || "") ||
    STOPWATCH_PUBLIC_ORIGIN !== origin.origin) throw new Error("Run from the reviewed StopWatch updater user service");
const root = await realpath(STOPWATCH_HOME);
const manager = new PortalUpdateManager(root, {
  origin: origin.origin, manifestUrl: config.portalManifestUrl,
  publicKey: await readFile(path.join(root, "release-public.pem")),
  extract: async (archive, destination) => {
    // The archive has already passed the signed SHA-256 and size checks.
    await exec("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination], { timeout: 120000 });
  },
  check, restart: () => exec("systemctl", ["--user", "restart", "stopwatch.service"], { timeout: 30000 }),
  health: expected => health(port, expected),
});
const result = await manager.run();
console.log(`StopWatch portal: ${result.state}${result.version ? ` ${result.version}` : ""}`);
