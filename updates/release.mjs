export const releaseComponents = Object.freeze({
  firmware: ["stopwatch-firmware.bin", "firmware-manifest.json"],
  miao: ["miao.pack", "miao-manifest.json"],
  bridge: ["stopwatch-bridge.mjs", "bridge-manifest.json"],
  portal: ["stopwatch-portal.tar.gz", "portal-manifest.json"],
});
export function releaseAssetUrl(config, repository, tag, asset) {
  if (!/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(tag) ||
      !Object.values(releaseComponents).flat().includes(asset)) throw new Error("Invalid release asset");
  if (!config.artifactBaseUrl) return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
  const base = new URL(config.artifactBaseUrl);
  if (base.origin !== config.productionOrigin || base.protocol !== "https:" ||
      base.pathname !== "/updates" || base.search || base.hash || base.username || base.password)
    throw new Error("Release mirror must be the reviewed production /updates origin");
  return `${base.href}/releases/${tag}/${asset}`;
}
export function annotatedReleaseTime(ref, annotation, tag, build) {
  if(ref?.object?.type!=="tag"||!/^[a-f0-9]{40}$/.test(ref.object.sha)||
      annotation?.sha!==ref.object.sha||annotation.tag!==tag||
      annotation.object?.type!=="commit"||annotation.object.sha!==build||
      !/^[a-f0-9]{40}$/.test(build))throw new Error("Annotated stable tag must target the exact checked commit");
  if(typeof annotation.tagger?.date!=="string")throw new Error("Invalid annotated release time");
  const time=new Date(annotation.tagger.date);
  if(!Number.isFinite(time.getTime()))throw new Error("Invalid annotated release time");
  return time.toISOString();
}
