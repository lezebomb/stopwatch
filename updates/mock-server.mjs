import https from "node:https";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { signedManifest, sha256 } from "./security.mjs";
import config from "../release/config.json" with { type: "json" };
export async function mockIdentity(directory) {
  await mkdir(directory, { recursive: true });
  const openssl =
    process.env.OPENSSL_BIN ||
    [
      "D:/Git/usr/bin/openssl.exe",
      "C:/Program Files/Git/usr/bin/openssl.exe",
    ].find((p) => existsSync(p)) ||
    "openssl";
  const key = path.join(directory, "tls.key"),
    cert = path.join(directory, "tls.crt");
  if (!existsSync(cert))
    execFileSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "3",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "pipe", windowsHide: true },
    );
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { tlsKey: await readFile(key), ca: await readFile(cert), ...pair };
}
export async function createMockUpdates({
  directory,
  port = 0,
  binary = Buffer.alloc(32768, 0x5a),
  version = "0.2.1",
  sequence = Date.now(),
} = {}) {
  directory ||= await mkdtemp(path.join(os.tmpdir(), "sw-ota-"));
  const identity = await mockIdentity(directory);
  let behavior = "normal",
    url;
  const manifest = () => ({
    schema: 1,
    kind: "firmware",
    channel: "stable",
    version,
    sequence,
    hardware: config.hardware,
    buildId: "mock-build-001",
    size: binary.length,
    sha256: sha256(binary),
    url: `${url}/firmware.bin`,
    publishedAt: new Date().toISOString(),
    compatibility: {
      partitionLayout: config.partitionLayout,
      dataSchema: 1,
      idf: "6.0.3",
    },
  });
  const server = https.createServer(
    { key: identity.tlsKey, cert: identity.ca },
    (req, res) => {
      if (req.url === "/manifest.json") {
        let envelope = signedManifest(manifest(), identity.privateKey);
        if (behavior === "bad-signature")
          envelope.signature = Buffer.alloc(384).toString("base64");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(envelope));
        return;
      }
      if (req.url === "/firmware.bin") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": binary.length,
        });
        if (behavior === "disconnect") {
          res.write(binary.subarray(0, 100));
          res.destroy();
          return;
        }
        const output = Buffer.from(binary);
        if (behavior === "corrupt") output[output.length - 1] ^= 1;
        if (behavior === "truncated") {
          res.end(output.subarray(0, 100));
          return;
        }
        res.end(output);
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  url = `https://127.0.0.1:${server.address().port}`;
  return {
    url,
    directory,
    ...identity,
    manifest,
    behavior: (value) => {
      behavior = value;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
