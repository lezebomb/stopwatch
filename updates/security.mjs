import {
  createHash,
  sign,
  verify,
  constants,
  createPublicKey,
} from "node:crypto";
import config from "../release/config.json" with { type: "json" };
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const fingerprint = (key) =>
  sha256(createPublicKey(key).export({ type: "spki", format: "der" }));
export function compareVersion(a, b) {
  const parse = (v) => {
    if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v))
      throw new Error("Invalid strict version");
    return v.split(".").map(Number);
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
export function validateManifest(
  m,
  {
    kind,
    currentVersion = "0.0.0",
    highestSequence = 0,
    hardware = config.hardware,
    now = Date.now(),
    allowLoopback = false,
  } = {},
) {
  if (
    !m ||
    m.schema !== 1 ||
    m.kind !== kind ||
    m.channel !== "stable" ||
    !/^[a-zA-Z0-9_-]{7,64}$/.test(m.buildId || "")
  )
    throw new Error("Unsupported update identity");
  compareVersion(m.version, currentVersion);
  if (compareVersion(m.version, currentVersion) <= 0)
    throw new Error("Update is not newer");
  if (!Number.isSafeInteger(m.sequence) || m.sequence <= highestSequence)
    throw new Error("Update replay rejected");
  if (
    !Number.isSafeInteger(m.size) ||
    m.size <= 0 ||
    m.size >
      (kind === "firmware"
        ? 0x400000
        : kind === "resources"
          ? 6 * 1024 * 1024
          : 200 * 1024 * 1024)
  )
    throw new Error("Invalid update size");
  if (!/^[a-f0-9]{64}$/.test(m.sha256 || ""))
    throw new Error("Invalid SHA-256");
  const published = Date.parse(m.publishedAt);
  if (!Number.isFinite(published) || published > now + 300000)
    throw new Error("Invalid release time");
  const url = new URL(m.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("HTTPS update URL required");
  if (
    !allowLoopback &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Loopback release not permitted");
  if (
    kind === "firmware" &&
    (m.hardware !== hardware ||
      m.compatibility?.partitionLayout !== config.partitionLayout ||
      m.compatibility?.dataSchema !== config.dataSchema ||
      m.compatibility?.idf !== "6.0.3")
  )
    throw new Error("Incompatible device/layout/schema");
  if (
    kind === "bridge" &&
    (m.hardware !== "windows-x64" || m.compatibility?.protocol !== 1)
  )
    throw new Error("Incompatible bridge");
  if (
    kind === "resources" &&
    (!Array.isArray(m.files) ||
      m.files.length > 12 ||
      m.compatibility?.dataSchema !== 1 ||
      m.namespace !== "system")
  )
    throw new Error("Invalid resource namespace");
  return m;
}
export function signedManifest(payload, privateKey, keyId = config.keyId) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign("sha256", bytes, {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return {
    algorithm: "RSA-PSS-SHA256",
    keyId,
    payload: bytes.toString("base64"),
    signature: signature.toString("base64"),
  };
}
export function verifyManifest(envelope, publicKey, options) {
  if (
    !envelope ||
    envelope.algorithm !== "RSA-PSS-SHA256" ||
    envelope.keyId !== config.keyId ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 24000 ||
    typeof envelope.signature !== "string"
  )
    throw new Error("Invalid signed envelope");
  const bytes = Buffer.from(envelope.payload, "base64"),
    signature = Buffer.from(envelope.signature, "base64");
  if (
    bytes.toString("base64") !== envelope.payload ||
    signature.length !== 384 ||
    !verify(
      "sha256",
      bytes,
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      signature,
    )
  )
    throw new Error("Release signature rejected");
  return validateManifest(JSON.parse(bytes.toString("utf8")), options);
}
