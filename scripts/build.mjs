import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assets } from "./assets.mjs";
await assets();
const preview = process.argv.includes("--preview");
const production = process.argv.includes("--production");
if (production) {
  const config = JSON.parse(await readFile("release/config.json", "utf8"));
  if (
    !config.productionOrigin ||
    new URL(config.productionOrigin).protocol !== "https:"
  )
    throw new Error(
      "Fixed production HTTPS origin must be configured before packaging production portal",
    );
}
const output = preview
  ? "preview-dist"
  : production
    ? "production-dist"
    : "dist";
const buildId = process.env.SW_BUILD_ID || process.env.GITHUB_SHA || "local";
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["web/app.mjs"],
  bundle: true,
  format: "esm",
  outfile: `${output}/app.js`,
  minify: true,
  sourcemap: false,
  define: {
    __SW_PREVIEW__: String(preview),
    __SW_BUILD_ID__: JSON.stringify(buildId),
  },
  target: "es2022",
});
const appName = `app.${createHash("sha256")
  .update(await readFile(`${output}/app.js`))
  .digest("hex")
  .slice(0, 12)}.js`;
await rename(`${output}/app.js`, `${output}/${appName}`);
await writeFile(
  `${output}/index.html`,
  (await readFile("web/index.html", "utf8")).replace(
    "./app.js",
    `./${appName}`,
  ),
);
const css = await readFile("web/style.css");
const cssName = `style.${createHash("sha256").update(css).digest("hex").slice(0, 12)}.css`;
await writeFile(`${output}/${cssName}`, css);
await writeFile(
  `${output}/index.html`,
  (await readFile(`${output}/index.html`, "utf8")).replace(
    "./style.css",
    `./${cssName}`,
  ),
);
await cp("assets/photos", `${output}/photos`, { recursive: true });
const version = JSON.parse(
  await readFile("release/config.json", "utf8"),
).version;
await writeFile(
  `${output}/version.json`,
  JSON.stringify({
    version,
    mode: preview ? "isolated-demo" : production ? "production" : "local",
    build: buildId,
  }),
);
await writeFile(`${output}/.nojekyll`, "");
console.log(
  `Web build complete: ${output}/ (${preview ? "ISOLATED DEMO; no remote control" : "local developer console"})`,
);
