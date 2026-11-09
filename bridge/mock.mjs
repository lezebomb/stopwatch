const randomUUID = () => globalThis.crypto.randomUUID();
export class MockCodex {
  constructor({ emit, tasks = [], delay = 800 }) {
    this.emit = emit;
    this.tasks = new Map(tasks.map((t) => [t.id, t]));
    this.timers = new Map();
    this.delay = delay;
  }
  output(task, state, message, extra = {}) {
    const updated = {
      ...task,
      state,
      operation: message,
      updated: Date.now(),
      mode: "mock",
      ...extra,
    };
    this.tasks.set(task.id, updated);
    this.emit("task", updated);
    return updated;
  }
  cancel(id) {
    for (const timer of this.timers.get(id) || []) clearTimeout(timer);
    this.timers.delete(id);
  }
  later(task, fn, steps = 1) {
    const timer = setTimeout(() => {
      if (this.tasks.get(task.id)?.state !== "interrupted") fn();
    }, this.delay * steps);
    this.timers.set(task.id, [...(this.timers.get(task.id) || []), timer]);
  }
  run(task) {
    this.cancel(task.id);
    task = this.output(task, "thinking", "Mock：分析任务");
    this.later(
      task,
      () =>
        this.output(this.tasks.get(task.id), "working", "Mock：编辑项目文件"),
      1,
    );
    this.later(
      task,
      () => {
        const current = this.tasks.get(task.id);
        if (/审批|approval/i.test(current.prompt))
          return this.output(current, "approval", "Mock：需要确认测试命令", {
            approvalId: randomUUID(),
            approval: {
              command: "mock-test --workspace-only",
              cwd: "mock-workspace",
              reason: "演示审批，不会执行真实命令",
            },
          });
        this.finish(current);
      },
      2,
    );
  }
  finish(task) {
    this.cancel(task.id);
    task = this.output(task, "testing", "Mock：运行模拟测试");
    this.later(
      task,
      () => {
        this.cancel(task.id);
        this.output(
          this.tasks.get(task.id),
          /失败|fail/i.test(task.prompt) ? "failed" : "completed",
          /失败|fail/i.test(task.prompt)
            ? "Mock：模拟测试失败"
            : "Mock：已完成",
          {
            result: /失败|fail/i.test(task.prompt)
              ? "演示失败：断言不满足。没有执行真实测试。"
              : "模拟结果：界面与协议演示完成。这不是实际 Codex 执行结果。",
            approvalId: null,
          },
        );
      },
      2,
    );
  }
  command(command) {
    if (command.action === "start") {
      const task = {
        id: command.id,
        title: command.text.slice(0, 36),
        prompt: command.text,
        project: "StopWatch / Mock",
        created: Date.now(),
        history: [],
      };
      this.run(task);
      return;
    }
    const task = this.tasks.get(command.taskId);
    if (!task) throw new Error("任务不存在");
    if (command.action === "interrupt") {
      this.cancel(task.id);
      this.output(task, "interrupted", "Mock：用户中断");
      return;
    }
    if (command.action === "approve") {
      if (task.state !== "approval" || task.approvalId !== command.approvalId)
        throw new Error("审批已失效");
      if (command.decision === "decline")
        this.output(task, "failed", "Mock：用户拒绝操作", {
          result: "已拒绝本次模拟命令",
          approvalId: null,
        });
      else this.finish({ ...task, approvalId: null });
      return;
    }
    if (command.action === "steer") {
      if (!["thinking", "working", "testing"].includes(task.state))
        throw new Error("只有执行中的任务可以追加指令");
      this.output(
        { ...task, prompt: `${task.prompt}\n${command.text}` },
        task.state,
        "Mock：已收到追加指令",
      );
      return;
    }
    if (command.action === "continue") {
      if (["thinking", "working", "testing", "approval"].includes(task.state))
        throw new Error("任务仍在执行");
      this.run({
        ...task,
        prompt: command.text,
        history: [...task.history, task.result || task.operation],
        result: null,
      });
    }
  }
  recover() {
    for (const task of this.tasks.values())
      if (["thinking", "working", "testing"].includes(task.state))
        this.output(task, "interrupted", "Mock：桥接重启，任务已停止，可继续");
  }
  close() {
    for (const id of this.timers.keys()) this.cancel(id);
  }
}
