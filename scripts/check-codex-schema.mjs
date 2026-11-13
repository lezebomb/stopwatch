import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
await mkdir(".deps/codex-schema", { recursive: true });
execFileSync(
  "codex",
  ["app-server", "generate-json-schema", "--out", ".deps/codex-schema"],
  { stdio: "inherit", windowsHide: true },
);
const schema = JSON.parse(
  await readFile(".deps/codex-schema/ClientRequest.json", "utf8"),
);
const methods = schema.oneOf
  .map(
    (variant) =>
      variant.properties?.method?.enum?.[0] ||
      variant.properties?.method?.const,
  )
  .filter(Boolean);
const required = [
  "initialize",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "account/rateLimits/read",
  "model/list",
];
for (const method of required)
  assert(methods.includes(method), `Missing real RPC method ${method}`);
const steer = JSON.parse(
  await readFile(".deps/codex-schema/v2/TurnSteerParams.json", "utf8"),
);
assert(steer.required.includes("expectedTurnId"));
const version = execFileSync("codex", ["--version"], {
  encoding: "utf8",
}).trim();
await writeFile(
  "artifacts/codex-schema-check.json",
  JSON.stringify(
    {
      version,
      methods: required,
      expectedTurnId: true,
      authenticated: false,
      realSessionsTested: false,
    },
    null,
    2,
  ),
);
console.log(
  `Verified ${required.length} methods against ${version}; no login or live RPC was performed.`,
);
