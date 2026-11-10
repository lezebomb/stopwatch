import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assets } from "./assets.mjs";
import { miaoAssets, copyMiaoWeb } from "./miao-assets.mjs";
const [, miao] = await Promise.all([assets(), miaoAssets()]);
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
const mode = preview ? "isolated-demo" : production ? "production" : "local";
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
    __SW_WEB_MODE__: JSON.stringify(mode),
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
await copyMiaoWeb(output, miao);
const version = JSON.parse(
  await readFile("release/config.json", "utf8"),
).version;
await writeFile(
  `${output}/version.json`,
  JSON.stringify({
    version,
    mode,
    build: buildId,
  }),
);
await writeFile(`${output}/.nojekyll`, "");
// A separate local-BLE utility. The demo bundle never imports or opens it.
await mkdir(`${output}/setup`, { recursive: true });
await build({ entryPoints: ["web/setup/app.mjs"], bundle: true, format: "esm", outfile: `${output}/setup/app.js`, minify: true, target: "es2022" });
const setupScript = await readFile(`${output}/setup/app.js`);
const setupName = `app.${createHash("sha256").update(setupScript).digest("hex").slice(0, 12)}.js`;
await rename(`${output}/setup/app.js`, `${output}/setup/${setupName}`);
const setupCss = await readFile("web/setup/style.css");
const setupCssName = `style.${createHash("sha256").update(setupCss).digest("hex").slice(0, 12)}.css`;
await writeFile(`${output}/setup/${setupCssName}`, setupCss);
await writeFile(`${output}/setup/index.html`, (await readFile("web/setup/index.html", "utf8")).replace("./app.js", `./${setupName}`).replace("./style.css", `./${setupCssName}`));
console.log(
  `Web build complete: ${output}/ (${mode})`,
);
