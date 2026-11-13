import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerTransport } from "./app-server.mjs";
function failureText(value) {
  try { const parsed = JSON.parse(value); value = parsed.error?.message || parsed.message || value; } catch {}
  return String(value || "Codex 请求失败").slice(0, 512);
}
export class AppServerCodex {
  constructor({
    emit,
    tasks = [],
    workspaces,
    executable,
    onStatus = () => {},
    transportFactory,
    approvalSeconds = 300,
    model,
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
    this.requestedModel = model;
    this.onStatus = (status) => {
      this.lastStatus = { ...status, mode: "production", updated: Date.now(),
        model: this.model || null, workspaces: this.workspaces.map(({ id, name }) => ({ id, name })) };
      onStatus(this.lastStatus);
    };
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
    clearTimeout(this.retry);
    this.ready = false;
    const generation = ++this.generation;
    this.onStatus({ state: "codex-connecting", online: false });
    this.rpc = this.transportFactory
      ? this.transportFactory({
          onNotification: (n) =>
            generation === this.generation && !this.closed && this.notify(n),
          onApproval: (r) =>
            generation === this.generation && !this.closed && this.approval(r),
          onDisconnect: () => this.disconnected(generation),
        })
      : new AppServerTransport({
          executable: this.executable,
          cwd: this.workspaces[0].path,
          onNotification: (n) =>
            generation === this.generation && !this.closed && this.notify(n),
          onApproval: (r) =>
            generation === this.generation && !this.closed && this.approval(r),
          onDisconnect: () => this.disconnected(generation),
        });
    try {
      await this.rpc.initialize();
      if (this.rpc.models) {
        const models = (await this.rpc.models()).data || [];
        this.model = this.requestedModel || models.find(m => m.isDefault)?.model;
        if (!this.model || !models.some(m => m.model === this.model)) throw new Error("选择的 Codex 模型当前不可用");
      }
      for (const task of this.tasks.values())
        if (task.appServerThreadId) {
          const project = this.authorizedProject(task);
          if (!project) {
            this.output(
              task,
              "interrupted",
              "此历史会话的工作区已不在当前授权范围",
              { restoreBlocked: true, approvalId: null },
            );
            continue;
          }
          let result;
          try {
            result = await this.rpc.resume(
              task.appServerThreadId,
              project.path,
              this.model,
            );
          } catch (error) {
            if (
              !/not found|does not exist|missing thread|unknown thread/i.test(
                error.message,
              )
            )
              throw error;
            this.output(task, "interrupted", "原会话已不存在，请创建新任务", {
              restoreBlocked: true,
              approvalId: null,
            });
            continue;
          }
          if (
            result.thread?.cwd &&
            path.resolve(result.thread.cwd) !== path.resolve(project.path)
          ) {
            this.output(
              task,
              "interrupted",
              "恢复会话的工作区不匹配，已停止控制",
              { restoreBlocked: true, approvalId: null },
            );
            continue;
          }
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
            {
              turnId: turn?.id || null,
              approvalId: null,
              restoreBlocked: false,
            },
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
    for (const task of this.tasks.values())
      if (task.approvalId) this.output(task, "interrupted", "连接中断，旧审批已失效", { approvalId: null, approval: null });
    this.onStatus({ state: "codex-offline", online: false });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), 3000);
  }
  relayConnected() {
    if (this.lastStatus) this.emit("bridgeStatus", this.lastStatus);
  }
  ownThread(threadId) {
    return [...this.tasks.values()].find(
      (t) =>
        t.appServerThreadId === threadId &&
        !t.restoreBlocked &&
        this.authorizedProject(t),
    );
  }
  authorizedProject(task) {
    return this.workspaces.find(
      (w) =>
        w.id === task.projectId &&
        task.projectPath &&
        path.resolve(w.path) === path.resolve(task.projectPath),
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
        p.turn?.error?.message ? failureText(p.turn.error.message) : "本轮任务已结束",
        { approvalId: null, approval: null, error: p.turn?.error?.message ? failureText(p.turn.error.message) : null, result: task.result || "" },
      );
    } else if (message.method === "item/agentMessage/delta") {
      this.output(task, task.state, "正在生成回复", {
        result: ((task.result || "") + (p.delta || "")).slice(-32768),
      });
    } else if (message.method === "item/completed" && p.item?.type === "agentMessage") {
      this.output(task, task.state, "回复已生成", { result: String(p.item.text || task.result || "").slice(-32768) });
    } else if (message.method === "error") {
      this.output(task, p.willRetry ? task.state : "failed", failureText(p.error?.message), { error: failureText(p.error?.message) });
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
    const approvalId = randomUUID();
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
      const result = await this.rpc.start(project.path, this.model);
      if (!result.thread?.id)
        throw new Error("App Server did not return a thread");
      const task = {
        id: c.id,
        appServerThreadId: result.thread.id,
        projectId: project.id,
        projectPath: project.path,
        project: project.name,
        title: c.text.slice(0, 36),
        prompt: c.text,
        created: Date.now(),
        history: [],
      };
      this.output(task, "thinking", "正在开始新任务");
      const turn = await this.rpc.turn(result.thread.id, c.text, this.model);
      this.output(this.tasks.get(task.id), "working", "任务已开始", {
        turnId: turn.turn?.id,
      });
      return;
    }
    const task = this.tasks.get(c.taskId);
    if (!task?.appServerThreadId) throw new Error("只能控制本桥接创建的会话");
    if (task.restoreBlocked || !this.authorizedProject(task))
      throw new Error("会话的工作区不在当前授权范围");
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
      if (["thinking", "working", "testing", "approval"].includes(task.state))
        throw new Error("任务仍在运行，请追加指令或先中断");
      await this.rpc.resume(task.appServerThreadId, task.projectPath, this.model);
      const result = await this.rpc.turn(task.appServerThreadId, c.text, this.model);
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
