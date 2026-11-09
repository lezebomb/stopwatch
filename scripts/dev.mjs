import { spawn } from "node:child_process";
const children = [];
const server = spawn(process.execPath, ["server/main.mjs"], {
  stdio: ["inherit", "pipe", "inherit"],
});
children.push(server);
let started = false;
server.stdout.on("data", (data) => {
  process.stdout.write(data);
  if (!started && data.toString().includes("MOCK relay")) {
    started = true;
    children.push(
      spawn(process.execPath, ["bridge/main.mjs"], { stdio: "inherit" }),
    );
  }
});
function stop() {
  for (const child of children) child.kill();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
server.on("exit", (code) => {
  stop();
  process.exit(code || 0);
});
