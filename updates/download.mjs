import https from "node:https";
import { createWriteStream } from "node:fs";
import { rename, unlink, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
export function request(
  url,
  { ca, limit = 24576, timeout = 15000, redirects = 0 } = {},
) {
  if (redirects > 4) throw new Error("Too many redirects");
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new Error("HTTPS required");
  return new Promise((resolve, reject) => {
    const req = https.get(target, { ca, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try {
          resolve(
            request(new URL(res.headers.location, target), {
              ca,
              limit,
              timeout,
              redirects: redirects + 1,
            }),
          );
        } catch (e) {
          reject(e);
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Update HTTP ${res.statusCode}`));
        return;
      }
      const length = Number(res.headers["content-length"]);
      if (Number.isFinite(length) && length > limit) {
        res.destroy();
        reject(new Error("Oversize response"));
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("Update timeout")));
    req.on("error", reject);
  });
}
export async function fetchEnvelope(url, options = {}) {
  const res = await request(url, options);
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 24576) {
      res.destroy();
      throw new Error("Oversize manifest");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function downloadVerified(manifest, destination, options = {}) {
  const temp = destination + `.${randomUUID()}.partial`;
  let out;
  try {
    const res = await request(manifest.url, {
      ...options,
      limit: manifest.size,
    });
    out = createWriteStream(temp, { flags: "wx", mode: 0o600 });
    const hash = createHash("sha256");
    let size = 0;
    // pipeline closes every stream before resolving/rejecting, including on
    // truncated TLS responses. Windows must release the file before rename.
    await pipeline(
      res,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > manifest.size) throw new Error("Update too large");
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256)
      throw new Error("Update size/hash mismatch");
    await rename(temp, destination);
    return destination;
  } catch (error) {
    out?.destroy();
    await unlink(temp).catch(() => {});
    throw error;
  }
}
