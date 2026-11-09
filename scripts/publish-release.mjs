import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!event.release?.id || event.release.draft || event.release.prerelease)
  throw new Error("Only published stable releases are supported");
const files = process.argv.slice(2);
const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${event.release.id}`;
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};
const listed = await fetch(`${api}/assets?per_page=100`, { headers });
if (!listed.ok) throw new Error(`Release inspection failed (${listed.status})`);
const assets = await listed.json();
for (const filename of files) {
  const name = filename.split(/[\\/]/).at(-1),
    bytes = await readFile(filename);
  const existing = assets.find((asset) => asset.name === name);
  if (existing) {
    const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    let digest = existing.digest;
    if (!digest) {
      const previous = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${existing.id}`,
        {
          headers: { ...headers, Accept: "application/octet-stream" },
        },
      );
      if (!previous.ok) throw new Error("Cannot verify existing release asset");
      digest = `sha256:${createHash("sha256")
        .update(Buffer.from(await previous.arrayBuffer()))
        .digest("hex")}`;
    }
    if (digest !== expected || existing.size !== bytes.length)
      throw new Error(
        `Immutable release asset ${name} differs; publish a new version`,
      );
    console.log(`Already published identical ${name}`);
    continue;
  }
  const res = await fetch(
    `https://uploads.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/${event.release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": name.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      },
      body: bytes,
    },
  );
  if (!res.ok) throw new Error(`Release upload failed (${res.status})`);
  console.log(`Published ${name}`);
}
