import { readFile, mkdir, readdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";
const description = JSON.parse(
  await readFile("firmware/build/project_description.json", "utf8"),
);
const output = path.resolve("release-output/firmware-notices");
await mkdir(output, { recursive: true });
await cp("LICENSE", path.join(output, "LICENSE"));
await cp("THIRD_PARTY_NOTICES.md", path.join(output, "THIRD_PARTY_NOTICES.md"));
const copied = [];
// Retain all license material inside the exact compiled component directories,
// including bundled libraries/fonts. This may include extra component notices.
async function collect(directory, destination) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const source = path.join(directory, entry.name),
      target = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await collect(source, target);
      continue;
    }
    if (
      !/^(licen[sc]e|copying|notice|ofl)([._-]|$)/i.test(entry.name) &&
      !/\.license$/i.test(entry.name)
    )
      continue;
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
    copied.push(path.relative(output, target).replaceAll("\\", "/"));
  }
}
for (const [name, info] of Object.entries(
  description.build_component_info || {},
)) {
  if (!/^[\w.-]+$/.test(name)) throw new Error("Unsafe component name");
  if (info.dir) await collect(info.dir, path.join(output, "components", name));
}
for (const [root, name] of [
  [".deps/muse", "Muse"],
  [process.env.IDF_PATH, "ESP-IDF"],
]) {
  if (!root) throw new Error("IDF_PATH required to retain SDK notices");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /^(license|notice)([._-]|$)/i.test(entry.name)) {
      const target = path.join(output, name, entry.name);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(root, entry.name), target);
      copied.push(path.relative(output, target).replaceAll("\\", "/"));
    }
  }
}
if (copied.length < 3) throw new Error("Incomplete firmware license catalog");
await writeFile(
  path.join(output, "catalog.json"),
  JSON.stringify(
    { components: description.build_components, notices: copied.sort() },
    null,
    2,
  ),
);
console.log(
  `Retained ${copied.length} SDK/component license files; no credentials or absolute build paths included.`,
);
