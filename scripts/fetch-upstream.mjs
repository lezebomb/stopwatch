import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const lock = JSON.parse(await readFile("upstream.lock.json", "utf8"));
await mkdir(".deps", { recursive: true });
const target = path.resolve(".deps/muse"),
  opts = ["-c", `safe.directory=${target.replaceAll("\\", "/")}`];
if (process.platform === "win32") opts.push("-c", "http.sslBackend=openssl");
const git = (args) =>
  execFileSync("git", [...opts, ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
if (!existsSync(`${target}/.git`)) {
  await mkdir(target, { recursive: true });
  git(["init", target]);
  git(["-C", target, "remote", "add", "origin", lock.muse.url]);
  git(["-C", target, "fetch", "--depth", "1", "origin", lock.muse.commit]);
  git(["-C", target, "checkout", "--detach", lock.muse.commit]);
}
const actual = execFileSync(
  "git",
  [...opts, "-C", target, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
if (actual !== lock.muse.commit)
  throw new Error("Unexpected upstream commit; refusing to overwrite checkout");
