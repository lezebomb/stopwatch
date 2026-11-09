import path from "node:path";
import { AppServerTransport } from "./app-server.mjs";
export class AppServerCodex {
  constructor({
    emit,
    tasks = [],
    workspaces,
    executable,
    onStatus = () => {},
    transportFactory,
    approvalSeconds = 300,
  }) {
    if (
      !workspaces?.length ||
      workspaces.some((w) => !w.id || !path.isAbsolute(w.path))
    )
      throw new Error("Explicit absolute workspace allowlist required");
    this.emit = emit;
    this.tasks = new Map(tasks.map((t) => [t.id, t]));
    this.workspaces = workspaces;
    this.executable = executable;
    this.onStatus = onStatus;
    this.transportFactory = transportFactory;
    this.approvalSeconds = approvalSeconds;
    this.approvals = new Map();
    this.closed = false;
    this.generation = 0;
    this.connect();
  }
  output(task, state, operation, extra = {}) {
    const updated = {
      ...task,
      state,
      operation,
      updated: Date.now(),
      mode: "production",
      ...extra,
    };
    this.tasks.set(task.id, updated);
    this.emit("task", updated);
    return updated;
  }
  async connect() {
    if (this.closed) return;
    const generation = ++this.generation;
    this.onStatus({ state: "codex-connecting", online: false });
    this.rpc = this.transportFactory
      ? this.transportFactory({
          onNotification: (n) => this.notify(n),
          onApproval: (r) => this.approval(r),
          onDisconnect: () => this.disconnected(generation),
        })
      : new AppServerTransport({
          executable: this.executable,
          cwd: this.workspaces[0].path,
          onNotification: (n) => this.notify(n),
          onApproval: (r) => this.approval(r),
          onDisconnect: () => this.disconnected(generation),
        });
    try {
      await this.rpc.initialize();
      for (const task of this.tasks.values())
        if (task.appServerThreadId) {
          const result = await this.rpc.resume(task.appServerThreadId);
          const turn = result.thread?.turns?.at(-1);
          const status = turn?.status;
          this.output(
            task,
            status === "inProgress"
              ? "working"
              : status === "failed"
                ? "failed"
                : status === "interrupted"
                  ? "interrupted"
                  : status === "completed"
                    ? "completed"
                    : "idle",
            status === "inProgress"
              ? "已恢复 App Server 线程状态"
              : "已恢复会话历史",
            { turnId: turn?.id || null, approvalId: null },
          );
        }
      this.ready = true;
      this.onStatus({ state: "codex-ready", online: true });
      try {
        const quota = await this.rpc.quota();
        if (!quota.mock)
          this.emit("quota", {
            mode: "production",
            ...(quota.rateLimits || {}),
            rateLimitsByLimitId: quota.rateLimitsByLimitId || null,
          });
      } catch (error) {
        if (/unauthor|sign.?in|login required/i.test(error.message))
          throw error;
        this.emit("quota", {
          mode: "production",
          primary: null,
          secondary: null,
          note: "当前账户或服务暂不提供额度数据",
        });
      }
    } catch (error) {
      this.ready = false;
      if (/auth|login|unauthor|sign.?in/i.test(error.message)) {
        this.authRequired = true;
        this.onStatus({
          state: "authorization-required",
          online: false,
          detail: "Codex 授权需要在本机恢复",
        });
        return;
      }
      this.onStatus({
        state: "codex-unavailable",
        online: false,
        detail: "服务暂不可用，将自动恢复",
      });
      if (!this.closed) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.reconnect(), 5000);
      }
    }
  }
  reconnect() {
    this.rpc?.close();
    this.connect();
  }
  disconnected(generation) {
    if (this.closed || generation !== this.generation || this.authRequired)
      return;
    this.ready = false;
    for (const pending of this.approvals.values()) clearTimeout(pending.timer);
    this.approvals.clear();
    this.onStatus({ state: "codex-offline", online: false });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), 3000);
  }
  ownThread(threadId) {
    return [...this.tasks.values()].find(
      (t) => t.appServerThreadId === threadId,
    );
  }
  notify(message) {
    const p = message.params || {};
    const task = this.ownThread(p.threadId);
    if (message.method === "account/rateLimits/updated") {
      this.emit("quota", { mode: "production", ...(p.rateLimits || {}) });
      return;
    }
    if (!task) return;
    if (message.method === "turn/started")
      this.output(task, "working", "Codex 正在执行", { turnId: p.turn?.id });
    else if (message.method === "turn/completed") {
      for (const [id, a] of this.approvals)
        if (a.taskId === task.id) {
          clearTimeout(a.timer);
          this.approvals.delete(id);
        }
      this.output(
        task,
        p.turn?.status === "failed"
          ? "failed"
          : p.turn?.status === "interrupted"
            ? "interrupted"
            : "completed",
        "本轮任务已结束",
        { approvalId: null, result: task.result || "" },
      );
    } else if (message.method === "item/agentMessage/delta") {
      this.output(task, task.state, "正在生成回复", {
        result: ((task.result || "") + (p.delta || "")).slice(-32768),
      });
    } else if (message.method === "item/started") {
      const item = p.item || {};
      const type = item.type;
      const testing =
        type === "commandExecution" &&
        /\b(npm (run )?test|pytest|ctest|go test)\b/.test(item.command || "");
      this.output(
        task,
        testing ? "testing" : type === "reasoning" ? "thinking" : "working",
        testing
          ? "正在运行测试"
          : type === "commandExecution"
            ? "正在执行命令"
            : "正在处理任务",
      );
    }
  }
  approval(request) {
    const p = request.params || {},
      task = this.ownThread(p.threadId);
    if (
      !task ||
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(request.method)
    ) {
      this.rpc.child?.stdin.write(
        JSON.stringify({
          id: request.id,
          error: { code: -32601, message: "Unsupported approval type" },
        }) + "\n",
      );
      return;
    }
    const approvalId = `${this.generation}:${request.id}`;
    const timer = setTimeout(() => {
      this.approvals.delete(approvalId);
      this.rpc.respondApproval(request.id, "decline");
      this.output(
        this.tasks.get(task.id),
        "failed",
        "审批超时，已拒绝本次操作",
        { approvalId: null },
      );
    }, this.approvalSeconds * 1000);
    this.approvals.set(approvalId, {
      serverId: request.id,
      taskId: task.id,
      generation: this.generation,
      timer,
    });
    this.output(task, "approval", "等待你确认本次操作", {
      approvalId,
      approval: {
        command: p.command || "文件修改",
        reason: p.reason || "请求访问工作区",
        expiresAt: Date.now() + this.approvalSeconds * 1000,
      },
    });
  }
  async command(c) {
    if (!this.ready || this.authRequired)
      throw new Error("Codex 尚未就绪或需要重新授权");
    if (c.action === "start") {
      const project = this.workspaces.find(
        (w) => w.id === (c.projectId || this.workspaces[0].id),
      );
      if (!project) throw new Error("工作区不在授权范围");
      const result = await this.rpc.start(project.path);
      if (!result.thread?.id)
        throw new Error("App Server did not return a thread");
      const task = {
        id: c.id,
        appServerThreadId: result.thread.id,
        projectId: project.id,
        project: project.name,
        title: c.text.slice(0, 36),
        prompt: c.text,
        created: Date.now(),
        history: [],
      };
      this.output(task, "thinking", "正在开始新任务");
      const turn = await this.rpc.turn(result.thread.id, c.text);
      this.output(this.tasks.get(task.id), "working", "任务已开始", {
        turnId: turn.turn?.id,
      });
      return;
    }
    const task = this.tasks.get(c.taskId);
    if (!task?.appServerThreadId) throw new Error("只能控制本桥接创建的会话");
    if (c.action === "approve") {
      const a = this.approvals.get(c.approvalId);
      if (!a || a.taskId !== task.id || a.generation !== this.generation)
        throw new Error("审批已过期或连接已变化");
      clearTimeout(a.timer);
      this.approvals.delete(c.approvalId);
      this.rpc.respondApproval(a.serverId, c.decision);
      this.output(
        task,
        c.decision === "decline" ? "interrupted" : "working",
        c.decision === "decline" ? "本次操作已拒绝" : "本次操作已批准",
        { approvalId: null },
      );
      return;
    }
    if (c.action === "interrupt") {
      if (!task.turnId) throw new Error("没有可中断的轮次");
      await this.rpc.interrupt(task.appServerThreadId, task.turnId);
      return;
    }
    if (c.action === "steer") {
      if (!task.turnId) throw new Error("没有可追加指令的轮次");
      await this.rpc.steer(task.appServerThreadId, task.turnId, c.text);
      return;
    }
    if (c.action === "continue") {
      await this.rpc.resume(task.appServerThreadId);
      const result = await this.rpc.turn(task.appServerThreadId, c.text);
      this.output(task, "working", "会话已继续", {
        turnId: result.turn?.id,
        result: "",
      });
      return;
    }
    throw new Error("不支持的远程操作");
  }
  recover() {} // connect() resumes only this bridge's persisted thread IDs.
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    for (const a of this.approvals.values()) clearTimeout(a.timer);
    this.rpc?.close();
  }
}
