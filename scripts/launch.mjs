import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
if (!existsSync("node_modules/sharp")) {
  const result = spawnSync("cmd.exe", ["/d", "/c", "npm.cmd ci --no-fund"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status) process.exit(result.status);
}
const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
});
if (built.status) process.exit(built.status);
const child = spawn(process.execPath, ["scripts/dev.mjs"], {
  stdio: ["inherit", "pipe", "inherit"],
});
let opened = false;
child.stdout.on("data", (data) => {
  process.stdout.write(data);
  const url = /http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/.exec(
    data.toString(),
  )?.[0];
  if (url && !opened) {
    opened = true;
    const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    if (existsSync(edge))
      spawn(edge, [url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
  }
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
child.on("exit", (code) => process.exit(code || 0));
