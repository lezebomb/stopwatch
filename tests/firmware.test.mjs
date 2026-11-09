import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
test("real C firmware model compiles and runs on Windows host", () => {
  const compiler = path.resolve(".tools/host/ziglang/zig.exe");
  assert(
    existsSync(compiler),
    "Install the host compiler with documented setup first",
  );
  mkdirSync("artifacts", { recursive: true });
  execFileSync(
    compiler,
    [
      "cc",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Ifirmware/companion",
      "firmware/companion/sw_model.c",
      "tests/firmware-host.c",
      "-o",
      "artifacts/firmware-host.exe",
    ],
    {
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: path.resolve(".tools/zig-cache"),
      },
      stdio: "pipe",
    },
  );
  const output = execFileSync(path.resolve("artifacts/firmware-host.exe"), [], {
    encoding: "utf8",
  });
  assert.match(output, /passed/);
});
test("16MiB partition map preserves upstream offsets and has no overlaps", () => {
  const rows = readFileSync("firmware/partitions.csv", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(","));
  let end = 0;
  for (const row of rows) {
    const offset = Number(row[3]),
      size = row[4].endsWith("M")
        ? parseInt(row[4]) * 1024 * 1024
        : Number(row[4]);
    assert(offset >= end);
    end = offset + size;
  }
  assert(end <= 16 * 1024 * 1024);
  assert.equal(rows.find((r) => r[0] === "prod_data")[3], "0x820000");
  assert.equal(rows.find((r) => r[0] === "photos")[4], "0x700000");
});
