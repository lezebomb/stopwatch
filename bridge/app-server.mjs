// Transport adapter only: deliberately not started by the Mock runtime.
// Methods verified against locally generated CLI schemas; see docs/UPSTREAM.md.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class AppServerTransport {
  constructor({
    executable = "codex",
    args = ["app-server", "--stdio"],
    cwd,
    onNotification = () => {},
    onApproval = () => {},
  }) {
    this.child = spawn(executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.next = 1;
    this.pending = new Map();
    this.onNotification = onNotification;
    this.onApproval = onApproval;
    this.child.stderr.on("data", () => {}); // Never forward potentially sensitive raw diagnostics.
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method && msg.id != null) onApproval(msg);
        else if (msg.method) onNotification(msg);
        else {
          const request = this.pending.get(msg.id);
          if (request) {
            clearTimeout(request.timer);
            this.pending.delete(msg.id);
            msg.error
              ? request.reject(new Error(msg.error.message))
              : request.resolve(msg.result);
          }
        }
      } catch {}
    });
    const rejectAll = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("App Server disconnected"));
      }
      this.pending.clear();
    };
    this.child.on("exit", rejectAll);
    this.child.on("error", rejectAll);
  }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "stopwatch_companion",
        title: "StopWatch",
        version: "0.1.0",
      },
    });
    this.child.stdin.write('{"method":"initialized"}\n');
    return result;
  }
  respondApproval(id, decision) {
    if (!["accept", "decline"].includes(decision))
      throw new Error("Unsupported approval decision");
    this.child.stdin.write(JSON.stringify({ id, result: { decision } }) + "\n");
  }
  list() {
    return this.request("thread/list", { limit: 30 });
  }
  read(threadId) {
    return this.request("thread/read", { threadId, includeTurns: true });
  }
  start(cwd) {
    return this.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  }
  resume(threadId) {
    return this.request("thread/resume", { threadId });
  }
  turn(threadId, text) {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }
  steer(threadId, turnId, text) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }
  interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
  quota() {
    return this.request("account/rateLimits/read", {});
  }
  close() {
    this.child.kill();
  }
}
