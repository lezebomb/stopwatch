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
    onDisconnect = () => {},
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
              ? request.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, definite: true }))
              : request.resolve(msg.result);
          }
        }
      } catch {}
    });
    const rejectAll = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error("App Server disconnected"), { code: "RPC_DISCONNECTED" }));
      }
      this.pending.clear();
    };
    let disconnected = false;
    const closed = () => {
      rejectAll();
      if (!disconnected) { disconnected = true; onDisconnect(); }
    };
    this.child.stdin.on("error", closed);
    this.child.on("exit", closed);
    this.child.on("error", closed);
  }
  request(method, params) {
    if (this.disposed || this.child.stdin.destroyed) return Promise.reject(Object.assign(new Error("App Server disconnected"), { code: "RPC_DISCONNECTED" }));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`RPC timeout: ${method}`), { code: "RPC_TIMEOUT" }));
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
        version: "0.2.0",
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
  models() { return this.request("model/list", {}); }
  start(cwd, model, sandbox = "workspace-write") {
    return this.request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: sandbox === "read-only" ? "never" : "on-request",
      approvalsReviewer: "user",
      sandbox,
    });
  }
  resume(threadId, cwd, model, sandbox = "workspace-write") {
    return this.request("thread/resume", {
      threadId,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      approvalPolicy: sandbox === "read-only" ? "never" : "on-request",
      approvalsReviewer: "user",
      sandbox,
    });
  }
  turn(threadId, text, model, sandbox = "workspace-write") {
    return this.request("turn/start", {
      threadId,
      ...(model ? { model } : {}),
      ...(sandbox === "read-only" ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } : {}),
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
    this.disposed = true;
    this.child.kill();
  }
}
