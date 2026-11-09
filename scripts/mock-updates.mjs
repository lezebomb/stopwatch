import { createMockUpdates } from "../updates/mock-server.mjs";
import { writeFile } from "node:fs/promises";
const mock = await createMockUpdates({
  directory: ".data/mock-updates",
  port: 8790,
});
await writeFile(".data/mock-updates/manifest-public.pem", mock.publicKey);
console.log(
  `MOCK HTTPS updates: ${mock.url}/manifest.json\nTest CA: .data/mock-updates/tls.crt\nNo device is contacted. Test keys are not production trust roots.`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await mock.close();
    process.exit(0);
  });
