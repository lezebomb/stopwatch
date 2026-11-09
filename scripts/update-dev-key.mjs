import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir(".data", { recursive: true });
try {
  await readFile(".data/update-dev-public.pem");
} catch {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await writeFile(".data/update-dev-private.pem", pair.privateKey, {
    mode: 0o600,
  });
  await writeFile(".data/update-dev-public.pem", pair.publicKey);
}
console.log(
  "Development update trust ready in ignored .data; NOT a production release key.",
);
