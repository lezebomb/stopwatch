import { createInterface } from "node:readline";
let initialized = false;
const send = (object) => process.stdout.write(JSON.stringify(object) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line),
    { method, id, params } = message;
  if (!method) {
    if (id === 700)
      send({ method: "mock/approvalDecision", params: message.result });
    return;
  }
  if (method === "initialize") {
    initialized = true;
    return send({ id, result: { mock: true } });
  }
  if (method === "initialized") return;
  if (!initialized)
    return send({ id, error: { code: -1, message: "Not initialized" } });
  if (method === "turn/steer" && !params.expectedTurnId)
    return send({
      id,
      error: { code: -1, message: "expectedTurnId required" },
    });
  if (method === "turn/start") {
    send({
      method: "turn/started",
      params: { threadId: params.threadId, turn: { id: "turn-mock" } },
    });
    send({
      id: 700,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: params.threadId,
        turnId: "turn-mock",
        itemId: "item-mock",
        command: "mock-only",
      },
    });
  }
  const result =
    method === "thread/list"
      ? { data: [{ id: "thread-mock" }] }
      : method === "account/rateLimits/read"
        ? { mock: true, rateLimits: { primary: null, secondary: null } }
        : {
            mock: true,
            thread: { id: "thread-mock" },
            turn: { id: "turn-mock" },
          };
  send({ id, result });
});
