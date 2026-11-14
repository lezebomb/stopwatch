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
