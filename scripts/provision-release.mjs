import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import config from "../release/config.json" with { type: "json" };
const publicPem = await readFile(config.productionPublicKey, "utf8").catch(
  () => {
    throw new Error(
      "Production public key has not been reviewed/committed; stable release is blocked",
    );
  },
);
const secret = process.env.RELEASE_SIGNING_KEY_PEM;
if (!secret)
  throw new Error(
    "production-signing / RELEASE_SIGNING_KEY_PEM secret is required",
  );
const key = createPublicKey(secret);
if (
  key.asymmetricKeyType !== "rsa" ||
  key.asymmetricKeyDetails.modulusLength !== 3072 ||
  key.export({ type: "spki", format: "pem" }) !==
    createPublicKey(publicPem).export({ type: "spki", format: "pem" })
)
  throw new Error("Production release key mismatch");
await mkdir(".secrets", { recursive: true, mode: 0o700 });
await writeFile(".secrets/release.pem", secret, { mode: 0o600 });
console.log(
  "Production signing identity validated. Private key is not printed.",
);
