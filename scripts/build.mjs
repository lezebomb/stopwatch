import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { assets } from "./assets.mjs";
await assets();
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["web/app.mjs"],
  bundle: true,
  format: "esm",
  outfile: "dist/app.js",
  minify: true,
  sourcemap: true,
});
await cp("web/index.html", "dist/index.html");
await cp("web/style.css", "dist/style.css");
await cp("assets/photos", "dist/photos", { recursive: true });
console.log("Web build complete: dist/");
