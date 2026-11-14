import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import config from "../release/config.json" with { type: "json" };
import { compareVersion, fingerprint } from "../updates/security.mjs";
import { annotatedReleaseTime } from "../updates/release.mjs";

const { GITHUB_REF, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_OUTPUT } = process.env;
const tag = `v${config.version}`;
compareVersion(config.version, "0.0.0");
if (GITHUB_REF !== `refs/tags/${tag}`) throw new Error(`Expected the stable tag ${tag}`);
const origin = config.productionOrigin && new URL(config.productionOrigin);
if (!origin || origin.protocol !== "https:" || origin.origin !== config.productionOrigin)
  throw new Error("The reviewed production HTTPS origin is required");
const key = await readFile(config.productionPublicKey, "utf8");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const build = git("rev-parse", "HEAD");
// checkout can replace its local annotated ref with the event's peeled commit.
// Verify the authoritative remote tag object; never weaken the annotation or
// exact-commit requirement to accommodate that local checkout behavior.
async function gitObject(suffix) {
  const response=await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/git/${suffix}`,{
    headers:{Authorization:`Bearer ${GITHUB_TOKEN}`,"X-GitHub-Api-Version":"2022-11-28"},
  });
  if(!response.ok)throw new Error(`Cannot verify stable tag (${response.status})`);
  return response.json();
}
const ref=await gitObject(`ref/tags/${encodeURIComponent(tag)}`);
if(ref.object?.type!=="tag")throw new Error("Use an annotated stable tag");
const published=annotatedReleaseTime(ref,await gitObject(`tags/${ref.object.sha}`),tag,build);
const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=${build}&per_page=1`, {
  headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
});
if (!response.ok || !(await response.json()).workflow_runs.some(run => run.head_sha === build && run.conclusion === "success"))
  throw new Error("The exact tagged commit must have passed main CI before stable packaging");
await appendFile(GITHUB_OUTPUT, `tag=${tag}\nbuild=${build}\npublished=${published}\n`);
console.log(`Stable ${tag} preflight passed (${build.slice(0, 12)}; trust ${fingerprint(key).slice(0, 12)})`);
