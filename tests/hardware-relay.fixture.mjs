import { createRelay } from "../server/app.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const directory = ".data/hardware-relay";
await mkdir(directory, { recursive: true });
const relay = await createRelay({ directory, port: 8789 });
const operator = relay.store.pair(relay.store.ticket("operator").code);
const viewer = relay.store.pair(relay.store.ticket("viewer").code);
await writeFile(
  directory + "/viewer.json",
  JSON.stringify({ token: viewer.token }),
  { mode: 0o600 },
);
const response = await fetch(relay.url + "/api/photos", {
  method: "POST",
  headers: {
    Origin: relay.url,
    Cookie: "sw_session=" + operator.token,
    "Content-Type": "image/jpeg",
    "X-Photo-Name": "hardware-test-landscape",
  },
  body: await readFile("assets/photos/2.jpg"),
});
if (!response.ok)
  throw new Error("Photo API upload failed: " + response.status);
const photo = await response.json();
relay.store.settings({ defaultPhoto: photo.id });
await writeFile(directory + "/uploaded-test.json", JSON.stringify(photo));
console.log(
  "Local-only photo relay ready at " +
    relay.url +
    "; viewer session stored privately; no execution bridge.",
);
process.on("SIGTERM", async () => {
  await relay.close();
  process.exit(0);
});
