import {
  defaultSettings,
  labels,
  nextScreen,
  powerPolicy,
  PHOTO_LIMIT,
} from "../shared/model.mjs";
import { guide } from "../shared/guide.mjs";
import releaseConfig from "../release/config.json" with { type: "json" };
const VERSION = releaseConfig.version;
import { installDemo } from "./demo.mjs";
import { watchVersion } from "./version-watch.mjs";
import { MiaoPlayer } from "./miao-player.mjs";
import { createCommandDispatcher, mergeCommandReceipt } from "./command-dispatch.mjs";
const WEB_MODE = typeof __SW_WEB_MODE__ === "undefined" ? "local" : __SW_WEB_MODE__;
const PREVIEW = typeof __SW_PREVIEW__ !== "undefined" && __SW_PREVIEW__;
const demo = PREVIEW ? await installDemo() : null;
const asset = (p) => new URL(p.replace(/^\//, ""), import.meta.url).href;
const miao = new MiaoPlayer(asset);
let watchInteraction = performance.now();
const photoUrl = (id) =>
  PREVIEW ? demo.photoUrl(id) : `/api/photos/${id}.jpg`;
const root = document.querySelector("#app");
let photoUploadActive = false;
let apiWrites = 0;
watchVersion(typeof __SW_BUILD_ID__ === "undefined" ? "local" : __SW_BUILD_ID__, WEB_MODE,
  () => !photoUploadActive && !apiWrites);
const state = {
  paired: false,
  mode: "mock",
  page: new URLSearchParams(location.search).get("view") === "settings" ? "settings" : "overview",
  tasks: [],
  workspaces: [],
  projectId: null,
  sandbox: "workspace-write",
  commandReceipts: [],
  photos: [],
  events: [],
  settings: { ...defaultSettings },
  bridgeOnline: false,
  deviceOnline: false,
  connected: false,
  cursor: 0,
  quota: null,
  session: null,
  sessions: [],
  device: null,
  photoBytes: 466 * 466 * 2,
  photoBudget: 6 * 1024 * 1024,
  photoLimit: 12,
  screen: "photos",
  photo: 0,
  charging: true,
  battery: 82,
  wifi: true,
  muse: "按住黄键，说点什么吧",
  listening: false,
  egg: false,
  unread: 0,
  selected: null,
  taps: 0,
  tapTime: 0,
  tick: 0,
};
const requestedTask = new URLSearchParams(location.search).get("task");
if (requestedTask) { state.selected = requestedTask; state.page = "tasks"; }
let reviewedApproval = null;
const inputDrafts = new Map();
const receiptLabels = { received: "中转已接收", accepted: "电脑已接收", executing: "正在执行", succeeded: "执行成功", failed: "执行失败", interrupted: "已中断", uncertain: "执行状态待核对" };
let ws,
  reconnect,
  canvas,
  ctx,
  lastSlide = Date.now(),
  photoImages = new Map(),
  audio,
  lastDraw = 0;
let readCursor = Number(localStorage.getItem("sw-read-cursor") || 0);
function markRead() {
  state.unread = 0;
  readCursor = state.cursor;
  localStorage.setItem("sw-read-cursor", readCursor);
}
const escape = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (timestamp) =>
  new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const date = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "暂无数据";
const active = () =>
  state.tasks.find((t) => t.id === state.selected) ||
  (state.selected && state.commandReceipts.some(r => r.taskId === state.selected) ? null :
    [...state.tasks].sort((a, b) => b.updated - a.updated)[0]);
function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.role = "status";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}
async function api(route, data, method = "POST") {
  const writing = data !== undefined;
  if (writing) apiWrites++;
  try {
    const response = await fetch(`/api/${route}`, writing ? {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    } : {});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "请求失败"), { status: response.status });
    return result;
  } finally {
    if (writing) apiWrites--;
  }
}
function merge(snapshot) {
  const cover = state.settings.defaultPhoto;
  for (const key of [
    "tasks",
    "photos",
    "settings",
    "bridgeOnline",
    "deviceOnline",
    "sessions",
    "quota",
    "mode",
    "executionEnabled",
    "codex",
    "commandReceipts",
    "device", "photoBytes", "photoBudget", "photoLimit",
  ])
    if (key in snapshot) state[key] = snapshot[key];
  if (Array.isArray(snapshot.workspaces)) state.workspaces = snapshot.workspaces;
  if (snapshot.session) state.session = snapshot.session;
  if (cover !== state.settings.defaultPhoto || !state.paired)
    state.photo = Math.max(
      0,
      allPhotos().findIndex((p) => p.id === state.settings.defaultPhoto),
    );
}
async function boot() {
  if (!PREVIEW) {
    try {
      state.mode = (await api("health")).mode || "mock";
    } catch {}
  }
  if (PREVIEW) document.title = "StopWatch · 隔离演示";
  const match = /pair=([\w-]+)/.exec(location.hash);
  if (match) {
    history.replaceState(null, "", location.pathname);
    try {
      await api("pair", { code: match[1] });
    } catch (e) {
      toast(e.message);
    }
  }
  try {
    const snapshot = await api("state");
    state.paired = true;
    merge(snapshot);
    const savedCursor = PREVIEW
      ? 0
      : Number(localStorage.getItem("sw-cursor") || 0);
    state.cursor = Number.isSafeInteger(savedCursor) ? savedCursor : 0;
    const response = await api(
      `events?after=${Math.max(0, state.cursor - 30)}`,
    );
    for (const event of response.events) receive(event, true);
    render();
    connect();
  } catch {
    renderPair();
  }
}
function renderPair() {
  root.innerHTML = `<main class="pair-page"><section class="pair-card"><div class="brand"><span class="brandmark"></span>StopWatch</div><h1>配对设备</h1><p>输入两分钟内有效的六位配对码。</p><form id="pair-form"><label for="pair-code">配对码</label><input id="pair-code" inputmode="numeric" autocomplete="one-time-code" required placeholder="六位数字"><button>连接</button></form><p class="small">当前为本地 MOCK 预览 · 无需 Muse / Codex 账号<br>二维码不会包含长期控制密钥。</p></section></main>`;
  if (WEB_MODE === "production" || state.mode === "production") {
    const paragraphs = root.querySelectorAll(".pair-card p");
    paragraphs[0].textContent =
      "在挂件打开「手机控制」扫码，输入挂件验证码后直接进入。Wi-Fi 在网络设置中单独配置。";
    paragraphs[1].textContent =
      "下方登录码保留给维护者，普通手机使用扫码配对即可。";
    const link = document.createElement("a"); link.href = "/pair/"; link.className = "button"; link.textContent = "开始手机配对";
    root.querySelector("#pair-form").before(link);
  }
  document.querySelector("#pair-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("pair", {
        code: document.querySelector("#pair-code").value.trim(),
      });
      await boot();
    } catch (error) {
      toast(error.message);
    }
  };
}
function connect() {
  clearTimeout(reconnect);
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events?after=${state.cursor}`,
  );
  ws.onopen = () => {
    state.connected = true;
    render();
  };
  ws.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.type === "snapshot") {
        merge(data.state);
        render();
      } else if (data.type === "event") receive(data.event);
      else if (data.type === "device") {
        state.deviceOnline = data.online; state.device = data.status;
        if (!photoUploadActive && ["overview", "network"].includes(state.page)) renderPreservingFocus();
      }
      else if (data.type === "bridge") {
        const deviceOnline = typeof data.deviceOnline === "boolean" ? data.deviceOnline : state.deviceOnline;
        if (state.bridgeOnline === data.online && state.deviceOnline === deviceOnline) return;
        state.bridgeOnline = data.online;
        if (!data.online) { state.codex = { ...state.codex, online: false }; state.quota = null; }
        state.deviceOnline = deviceOnline;
        render();
      }
    } catch {}
  };
  ws.onclose = (event) => {
    state.connected = false;
    state.bridgeOnline = false;
    state.codex = { ...state.codex, online: false };
    state.quota = null;
    if (event.code === 4001) {
      state.paired = false;
      boot();
      return;
    }
    render();
    reconnect = setTimeout(connect, 1500 + Math.random() * 500);
  };
}
function receive(event, silent = false) {
  if (state.events.some((e) => e.id === event.id)) return;
  if (event.seq <= state.cursor && !silent) return;
  state.cursor = Math.max(state.cursor, event.seq);
  localStorage.setItem("sw-cursor", state.cursor);
  state.events = [...state.events, event].slice(-80);
  if (event.type === "task") {
    const previous = state.tasks.find((t) => t.id === event.payload.id);
    state.tasks = state.tasks
      .filter((t) => t.id !== event.payload.id)
      .concat(event.payload);
    if (
      ["completed", "failed", "approval"].includes(event.payload.state) &&
      event.seq > readCursor
    ) {
      if (state.page !== "tasks") state.unread++;
      if (!silent && previous?.state !== event.payload.state)
        toast(`${labels[event.payload.state]} · ${event.payload.title}`);
    }
  }
  if (event.type === "quota") state.quota = event.payload;
  if (event.type === "bridgeStatus") {
    state.codex = event.payload;
    if (!event.payload.online) state.quota = null;
    if (Array.isArray(event.payload.workspaces)) state.workspaces = event.payload.workspaces;
  }
  if (event.type === "settings") state.settings = event.payload;
  if (event.type === "photos") state.photos = event.payload.photos;
  if (event.type === "commandError" && !silent) toast(event.payload.message);
  if (event.type === "commandStatus") {
    state.commandReceipts = mergeCommandReceipt(state.commandReceipts, event.payload);
  }
  if (!silent) renderPreservingFocus();
}
function renderPreservingFocus() {
  // render() already restores textarea drafts by task id. Restoring only by
  // DOM id here would put the previous task's draft into a newly selected task.
  if (document.activeElement?.tagName === "TEXTAREA") { render(); return; }
  const focus = document.activeElement,
    focusId = focus?.id,
    value = focus?.value,
    start = focus?.selectionStart;
  render();
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next && value != null && ["TEXTAREA", "INPUT"].includes(next.tagName)) {
      next.value = value;
      next.focus();
      try {
        next.setSelectionRange(start, start);
      } catch {}
    }
  }
}
const taskEvents = () =>
  [...state.events].filter((e) => e.type === "task").reverse();
function eventList(limit = 4) {
  const events = taskEvents().slice(0, limit);
  return events.length
    ? events
        .map(
          (e) =>
            `<div class="event-row"><span class="event-mark"></span><div>${escape(e.payload.operation)}<span class="event-time">${time(e.time || Date.now())} · ${escape(e.payload.title)}</span></div></div>`,
        )
        .join("")
    : '<div class="empty">暂无任务消息。</div>';
}
function watchCard() {
  return `<section class="card device-card"><div class="card-head"><h2>我的 StopWatch</h2><span class="device-label"><i class="dot off"></i>模拟设备</span></div><div class="watch-stage"><button class="hw-button yellow" id="yellow" aria-label="黄色按键：按住模拟录音"></button><button class="hw-button blue" id="blue" aria-label="蓝色按键：切换静音"></button><div class="watch"><canvas class="screen" id="screen" width="466" height="466" aria-label="466×466 圆屏模拟器，点击切图，左右滑动切换页面"></canvas></div></div><div class="screen-switch">${[
    ["photos", "照片"],
    ["muse", "Muse"],
    ["codex", "Codex"],
    ["guide", "指南"],
  ]
    .map(
      ([key, title]) =>
        `<button data-screen="${key}" class="${state.screen === key ? "selected" : ""}">${title}</button>`,
    )
    .join(
      "",
    )}</div><p class="device-caption">轻点换一张 · 左右滑动切换 · 连点五下有惊喜</p><div class="device-controls"><label><input type="checkbox" id="charging" ${state.charging ? "checked" : ""}>充电</label><label><input type="checkbox" id="wifi" ${state.wifi ? "checked" : ""}>Wi-Fi</label><label>电量<input type="range" id="battery" min="0" max="100" value="${state.battery}" aria-label="模拟电量"><span class="battery-value">${state.battery}%</span></label></div></section>`;
}
function taskCard() {
  const task = active();
  const stage = ["thinking", "working", "testing", "completed"].indexOf(
    task?.state,
  );
  return `<section class="card"><div class="card-head"><h2>Codex 任务</h2><span class="tag">MOCK</span></div>${task ? `<div class="task-project">${escape(task.project)}</div><h3 class="task-title">${escape(task.title)}</h3><span class="task-status"><i class="dot"></i>${labels[task.state] || task.state}</span><p class="task-operation">${escape(task.operation)}</p><div class="progress-path" aria-label="任务阶段，不表示百分比">${[0, 1, 2, 3].map((i) => `<i class="${i <= stage ? "on" : ""}"></i>`).join("")}</div><div class="actions"><button data-page="tasks">任务详情 ↗</button>${["thinking", "working", "testing", "approval"].includes(task.state) ? '<button class="quiet" id="quick-interrupt">中断</button>' : ""}</div>` : `<h3 class="task-title">暂无任务</h3><p class="task-operation">创建一个任务开始执行。</p><div class="actions"><button data-page="tasks">新建任务 ↗</button><span class="task-status">${state.bridgeOnline ? (state.mode === "production" ? "电脑已连接" : "Mock 桥接在线") : "等待桥接连接"}</span></div>`}</section>`;
}
function quotaCard() {
  return `<section class="card"><div class="card-head"><h2>额度小看板</h2><span class="tag">${state.mode === "production" ? "账户额度" : "模拟额度"}</span></div><div class="quota-row">${[
    ["primary", "5 小时窗口"],
    ["secondary", "每周窗口"],
  ]
    .map(([key, title]) => {
      const q = state.quota?.[key];
      const displayTitle =
        state.mode === "production" &&
        q?.windowDurationMins !== (key === "primary" ? 300 : 10080)
          ? q?.windowDurationMins
            ? `${q.windowDurationMins} 分钟窗口`
            : "额度窗口"
          : title;
      return `<div><div class="quota-name">${escape(displayTitle)}</div><div class="quota-number">${q ? 100 - q.usedPercent + "%" : "—"}<span>剩余</span></div><div class="quota-track"><div class="quota-fill" data-width="${q ? 100 - q.usedPercent : 0}"></div></div><div class="quota-reset">${q ? date(q.resetsAt) + " 重置" : "等待桥接返回"}</div></div>`;
    })
    .join("")}</div></section>`;
}
function connectionCard() {
  const online = state.deviceOnline, device = state.device;
  const muse = !online ? "设备离线，状态待更新" : device?.museReady ? "在线" : device?.museLinked ? "已绑定，连接中" : device ? "尚未绑定" : "等待挂件报告";
  return `<section class="card"><h2>连接状态</h2><div class="connection-grid"><div>设备联网<strong>${online ? "已联网并同步" : "等待联网"}</strong></div><div>手机配对<strong>${state.session?.phone ? state.session.role === "manager" ? "已配对 · 照片管理" : "已配对 · 只读" : "已有控制台授权"}</strong></div><div>Muse<strong>${muse}</strong></div><div>Codex<strong>${state.codex?.online ? "在线" : state.bridgeOnline ? "电脑已连，等待 Codex" : "电脑离线"}</strong></div></div><p class="small muted">联网、手机授权和账号连接分别恢复。设备离线会保留照片，无需重配手机。</p></section>`;
}
function productionOverview() {
  const chosen = state.settings.defaultPhoto;
  const cover = chosen?.startsWith("builtin-") ? asset(`/photos/${chosen.slice(-1)}.jpg`) : photoUrl(chosen);
  return `<div class="panel-grid"><div><section class="card"><h2>当前封面</h2><img class="cover-preview" src="${cover}" alt="当前选择的挂件封面"><div class="actions"><button data-page="photos">上传照片与管理相册</button><button class="secondary" data-page="settings">显示与彩蛋设置</button></div><p class="small muted">${state.deviceOnline ? "设备在线，保存后自动无线同步" : "等待挂件联网；云端保存与手机配对会保留"}</p></section>${connectionCard()}</div><div class="right-stack"><section class="card"><h2>日常入口</h2><div class="home-actions"><button data-page="photos">相册管理</button><button data-page="network">网络设置</button><button data-page="tasks">Codex 任务与操作</button><button data-page="settings">设备与手机授权</button><button data-page="guide">使用指南</button></div></section>${quotaCard()}</div></div>`;
}
function networkPage() {
  return `${connectionCard()}<section class="card"><h2>Wi-Fi 是独立设置</h2><p>蓝键 → 网络 → 手机扫码设置网络，或使用官方 Wi-Fi 管理。手机已配对后不再需要控制台登录码。</p><p>使用普通 2.4 GHz Wi-Fi 或兼容热点。密码只通过加密蓝牙提交给挂件，不存到网页或云端。</p><div class="actions"><a class="button" href="/setup/">打开手机网络设置</a><a href="/guide/">查看指南</a></div><p class="small muted">切换网络保留 Muse 和手机授权；国内连接受限时挂件自动使用受认证的加密出口。</p></section>`;
}
function overview() {
  if (state.mode === "production") return productionOverview();
  const connectDevice = state.mode === "production" && state.session?.role === "operator" && !state.deviceOnline
    ? '<section class="card"><h2>连接你的 StopWatch</h2><p>先在挂件上打开「手机配网」。已连上 Wi-Fi 后，用手机 Chrome 点击下方按钮。</p><div class="actions"><button id="device-ticket">绑定 StopWatch</button><a href="/setup/">还没联网？先配网</a></div></section>'
    : "";
  return `${connectDevice}<div class="dashboard">${watchCard()}<div class="right-stack">${taskCard()}${quotaCard()}</div></div><div class="bottom-grid"><section class="card"><div class="card-head"><h2>照片</h2><button class="text-button" data-page="photos">管理 ↗</button></div><div class="mini-photos">${state.photos
    .slice(0, 2)
    .map(
      (p) =>
        `<img class="photo-thumb" src="${photoUrl(p.id)}" alt="${escape(p.name)}">`,
    )
    .join(
      "",
    )}</div><p class="muted small" style="">${state.photos.length} / 12 张自定义照片 · 默认离线展示</p></section><section class="card"><div class="card-head"><h2>最近的小消息</h2><button class="text-button" id="mark-read">全部已读${state.unread ? " · " + state.unread : ""}</button></div><div class="timeline">${eventList(3)}</div></section></div>`;
}
function tasks() {
  const task = active(),
    running = task && ["thinking", "working", "testing"].includes(task.state);
  return `<div class="notice">MOCK 演示：任务不会调用真实 Codex。输入“审批”体验确认流程，输入“失败”体验异常。</div><div class="panel-grid"><div><section class="card"><div class="card-head"><h2>新指令</h2><span class="tag">MOCK</span></div><form id="task-form"><label for="prompt">任务内容</label><textarea id="prompt" required maxlength="8000" placeholder="例如：检查照片上传，运行测试并申请审批"></textarea><p class="muted small">可使用手机输入法语音转文字。</p><button>创建 Mock 任务 ↗</button></form></section><h2 class="list-heading">会话与项目</h2><div class="task-list">${
    [...state.tasks]
      .reverse()
      .map(
        (t) =>
          `<button data-task="${escape(t.id)}" class="${task?.id === t.id ? "selected" : ""}">${escape(t.title)}<span class="muted">${escape(t.project)} · ${labels[t.state]}</span></button>`,
      )
      .join("") || '<p class="empty">还没有会话</p>'
  }</div></div><section class="card"><div class="card-head"><h2>任务详情</h2><span class="task-status">${task ? labels[task.state] : "等待会话状态"}</span></div>${commandReceiptCard(task)}${
    task
      ? `<h3 class="task-title">${escape(task.title)}</h3><p class="muted small">${escape(task.project)} · ${task.sandbox === "read-only" ? "只读沙箱" : "工作区沙箱"}</p><p class="muted small">${escape(task.operation)}</p>${task.state === "approval" ? approvalCard(task) : ""}${task.result ? `<div class="result">${escape(task.result)}</div>` : ""}<div class="timeline">${taskEvents()
          .filter((e) => e.payload.id === task.id)
          .slice(0, 8)
          .map(
            (e) =>
              `<div class="event-row"><span class="event-mark"></span><div>${escape(e.payload.operation)}<span class="event-time">${time(e.time || Date.now())}</span></div></div>`,
          )
          .join(
            "",
          )}</div><form id="continue-form" data-task-context="${escape(task.id)}"><label for="continuation">${running ? "追加指令" : "继续这个会话"}</label><textarea id="continuation" required maxlength="8000" placeholder="输入后续要求"></textarea><div class="actions"><button ${task.state === "approval" ? "disabled" : ""}>${running ? "追加到当前任务" : "继续任务"}</button><button type="button" class="danger" id="interrupt" ${!running && task.state !== "approval" ? "disabled" : ""}>中断任务</button></div></form>`
      : '<div class="empty">电脑尚未返回对应会话。可先查看指令回执；已接收不代表已执行，请勿重复创建。</div>'
  }</section></div>`;
}
function approvalCard(task) {
  const a = task.approval || {}, production = state.mode === "production";
  const reviewed = reviewedApproval?.id === task.approvalId && reviewedApproval?.digest === a.digest;
  return `<div class="approval"><strong>核对完整操作</strong><pre class="approval-details">${escape(a.command)}</pre><p>${escape(a.reason)}</p>${production ? `<pre class="approval-details">${escape(a.details || "完整内容不可用，不能远程批准。请拒绝本次，再要求 Codex 拆分操作。")}</pre>${a.complete ? `<label class="approval-review"><input id="approval-reviewed" type="checkbox" ${reviewed ? "checked" : ""}>我已核对完整操作和请求权限</label>` : ""}` : ""}<div class="actions"><button data-decision="accept" ${production && (!a.complete || !reviewed) ? "disabled" : ""}>批准本次</button><button class="danger" data-decision="decline">拒绝</button></div></div>`;
}
function commandReceiptCard(task) {
  const receipts = state.commandReceipts.filter(r => r.taskId === (state.selected || task?.id)).slice(0, 3);
  const actions = { start: "新任务", continue: "继续", steer: "追加", interrupt: "中断", approve: "审批" };
  return receipts.map(r => `<p class="small command-receipt" role="status">${escape(r.action === "approve" ? (r.decision === "decline" ? "拒绝审批" : "批准审批") : actions[r.action] || "指令")} · ${escape(receiptLabels[r.stage] || r.stage)}${r.updated ? ` · ${time(r.updated)}` : ""}${r.message ? ` · ${escape(r.message)}` : ""}</p>`).join("");
}
function photos() {
  const bytes = state.photos.reduce((sum, p) => sum + p.bytes, 0);
  const production = state.mode === "production";
  const perPhoto = state.photoBytes || 466 * 466 * 2;
  const safeFree = state.deviceOnline && Number.isSafeInteger(state.device?.storageTotal) && Number.isSafeInteger(state.device?.storageUsed)
    ? Math.max(0, Math.floor(state.device.storageTotal * .85) - state.device.storageUsed - 65536) : null;
  const remaining = Math.max(0, Math.min(state.photoLimit - state.photos.length, Math.floor((state.photoBudget - bytes) / perPhoto), safeFree === null ? state.photoLimit : Math.floor(safeFree / perPhoto)));
  const budgetNote = production && safeFree !== null ? `<p class="small muted" role="status">还可新增约 ${remaining} 张。</p>` : "";
  return `<div class="notice">${production ? "挂件联网后自动同步，离线保留已有照片。所有未隐藏照片会加入轮播。" : "本地演示相册。"}</div><div class="stat-line"><span>${state.photos.length} / ${state.photoLimit} 张</span><span>${(bytes / 1024 / 1024).toFixed(2)} / 6 MiB</span></div>${budgetNote}<div class="upload"><h2>为小小屏幕，留住大大的喜欢。</h2><p class="muted small">${production ? "上传前裁切到 466×466，并预览圆屏" : "自动居中裁切与缩放"} · JPG / PNG / WebP · 单张最多 8 MiB</p><label for="upload">选择照片</label><input type="file" id="upload" accept="image/jpeg,image/png,image/webp" ${production ? "multiple" : ""} ${production && remaining === 0 ? "disabled" : ""}></div><div class="photo-grid">${[
    0, 1, 2,
  ]
    .map((i) => ({
      id: `builtin-${i}`,
      builtin: true,
    }))
    .concat(state.photos)
    .map(
      (p) =>
        `<article class="photo-tile">${p.id === state.settings.eggPhoto ? '<p class="small muted">隐藏彩蛋</p>' : `<img src="${p.builtin ? asset(`/photos/${p.id.slice(-1)}.jpg`) : photoUrl(p.id)}" alt="${escape(p.name)}">`}<p>${escape(p.name)} ${state.settings.defaultPhoto === p.id ? "· 当前封面" : ""}</p><div class="actions">${p.id === state.settings.eggPhoto ? "" : `<button class="secondary" data-cover="${p.id}">设为封面</button><button class="quiet" data-rotate="${p.id}">加入轮播</button>`}${!p.builtin ? `<button class="secondary" data-hidden="${p.id}">${p.id === state.settings.eggPhoto ? "取消隐藏" : "设为隐藏"}</button><button class="danger" data-delete="${p.id}">删除</button>` : ""}</div></article>`,
    )
    .join("")}</div>`;
}
function settings() {
  const production = state.mode === "production";
  const canPair = production && state.session?.role === "operator";
  const roleName = { operator: "可控制", manager: "照片管理", viewer: "只读", bridge: "Windows 桥接", device: "StopWatch 挂件" };
  const displayOptions = `<label for="display-mode">显示模式</label><select id="display-mode">${[
    ["photo", "照片展示 · 低亮常显"], ["smart", "智能省电 · 逐步变暗"], ["endurance", "续航优先 · 尽早熄屏"],
  ].map(([id, title]) => `<option value="${id}" ${state.settings.displayMode === id ? "selected" : ""}>${title}</option>`).join("")}</select>
  <label for="sleep-after">闲置熄屏（秒，智能模式可填 0 保持低亮）</label>
  <input id="sleep-after" type="number" min="0" max="3600" value="${state.settings.sleepAfter ?? 180}">
  <label for="egg-photo">隐藏彩蛋照片</label><select id="egg-photo"><option value="">仅显示留言</option>${state.photos.map(p =>
    `<option value="${escape(p.id)}" ${p.id === state.settings.eggPhoto ? "selected" : ""}>${escape(p.name)}</option>`).join("")}</select>
  <p class="small muted">彩蛋照片会从日常轮播隐藏，可用五次轻点或指定日期打开。</p>`;
  return `<div class="panel-grid"><section class="card"><h2>设备设置</h2><div class="setting-row"><span>${production ? "挂件亮度" : "模拟屏幕亮度"} <strong id="brightness-value">${state.settings.brightness}%</strong></span><input id="brightness" type="range" min="10" max="80" step="5" value="${state.settings.brightness}" aria-label="亮度"></div><div class="setting-row"><span>扬声器静音</span><input id="audio-silent" type="checkbox" ${state.settings.audioSilent ? "checked" : ""}></div><div class="setting-row"><span>音量 <strong id="volume-value">${state.settings.volume ?? 50}%</strong></span><input id="volume" type="range" min="0" max="100" step="5" value="${state.settings.volume ?? 50}" aria-label="音量"></div><div class="setting-row"><span>照片自动轮播</span><input id="slideshow" type="checkbox" ${state.settings.slideshow ? "checked" : ""}></div><label for="slide-seconds">轮播间隔（秒）</label><input id="slide-seconds" type="number" min="5" max="300" value="${state.settings.slideSeconds}"><label for="border">封面装饰边框</label><select id="border"><option value="mint" ${state.settings.border === "mint" ? "selected" : ""}>薄荷绿</option><option value="gold" ${state.settings.border === "gold" ? "selected" : ""}>暖金色</option><option value="none" ${state.settings.border === "none" ? "selected" : ""}>无边框</option></select>${displayOptions}<label for="egg-message">彩蛋留言</label><textarea id="egg-message" maxlength="150">${escape(state.settings.eggMessage)}</textarea><label for="egg-date">纪念日（MM-DD）</label><input id="egg-date" value="${escape(state.settings.eggDate)}" maxlength="5"><button id="save-settings">保存设置</button></section><div class="right-stack"><section class="card"><h2>配对与设备授权</h2><p class="small muted">授权链接两分钟有效，使用一次后失效。</p><div class="actions"><button id="ticket">新建控制端二维码</button><button class="secondary" id="viewer-ticket">新建只读端</button>${canPair ? '<button class="secondary" id="device-ticket">绑定 StopWatch</button>' : ""}</div><div id="ticket-result"></div><h3 class="list-heading">已授权设备与浏览器</h3>${state.sessions
    .filter((s) => !s.revoked)
    .map(
      (s) =>
        `<div class="setting-row"><span>${escape(s.id.slice(0, 8))} · ${roleName[s.role] || "其他"} ${s.id === state.session?.id ? "（当前）" : ""}</span>${s.role === "device" && canPair ? `<button class="secondary" data-device-control="${s.id}" data-enabled="${!!s.deviceControl}">${s.deviceControl ? "关闭挂件操作" : "授权挂件操作"}</button>` : ""}<button class="danger" data-revoke="${s.id}">撤销</button></div>`,
    )
    .join(
      "",
    )}</section><section class="card"><h2>连接情况</h2><p class="small muted">中转服务：${state.connected ? "在线" : "重连中"}<br>Windows ${production ? "" : "Mock "}桥接：${state.bridgeOnline ? "在线" : "离线"}<br>StopWatch 实物：${state.connected && state.deviceOnline ? "最近已同步" : "暂无在线挂件"}</p><button class="quiet" id="disconnect">${production ? "重新连接" : "模拟事件连接断开 / 重连"}</button></section></div></div>`;
}
function guidePage() {
  return `<div class="guide-grid">${guide.map(([title, text], i) => `<article class="guide-card"><div class="number">GUIDE / ${String(i + 1).padStart(2, "0")}</div><h2>${title}</h2><p>${text}</p></article>`).join("")}</div>`;
}
function render() {
  for (const el of root.querySelectorAll("textarea")) inputDrafts.set(`${el.id}:${el.closest("[data-task-context]")?.dataset.taskContext || ""}`, el.value);
  const editing = document.activeElement?.tagName === "TEXTAREA" ?
    { id: document.activeElement.id, context: document.activeElement.closest("[data-task-context]")?.dataset.taskContext || "", start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  if (!state.paired) return;
  if (state.page === "tasks") markRead();
  const nav = [
    ["overview", "◉", "陪伴总览"],
    ["tasks", "⌘", "Codex 任务"],
    ["photos", "▧", "照片时光"],
    ...(state.mode === "production" ? [["network", "◎", "网络"]] : []),
    ["settings", "⚙", "设备设置"],
    ["guide", "☷", "使用指南"],
  ];
  const titles = {
    overview: ["设备概览", "封面、任务与额度状态。"],
    tasks: ["Codex 任务", "查看与操作正在运行的任务。"],
    photos: ["相册", "上传、设封面、轮播与隐藏彩蛋。"],
    network: ["网络与授权，各自清楚。", "换 Wi-Fi 不需要重新配对手机或 Muse 账号。"],
    settings: ["设备设置", "亮度、显示模式、静音与彩蛋。"],
    guide: ["使用指南", "按键、配对与常见问题。"],
  };
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark"></span>StopWatch</div><nav class="nav" aria-label="主导航">${nav.map(([key, icon, title]) => `<button data-page="${key}" class="${state.page === key ? "active" : ""}"><span class="nav-icon">${icon}</span>${title}${key === "tasks" && state.unread ? `<span class="unread">${state.unread}</span>` : ""}</button>`).join("")}</nav><div class="side-bottom"><p class="small muted">v${VERSION}</p></div></aside><main class="main"><header class="topbar"><div class="top-actions"><span><i class="dot ${state.bridgeOnline ? "" : "off"}"></i> ${state.bridgeOnline ? "桥接在线" : "桥接离线"}</span><span class="tag">MOCK PREVIEW</span></div></header><div class="pagehead"><h1>${titles[state.page][0]}</h1><p>${titles[state.page][1]}</p></div>${!state.connected ? '<div class="offline-banner">事件连接已断开，正在自动重连。</div>' : ""}${{ overview, tasks, photos, network: networkPage, settings, guide: guidePage }[state.page]()}<footer class="footer"><span>StopWatch Companion</span></footer></main></div>`;
  if (state.mode === "production") {
    if (state.page === "settings" && state.session?.phone) {
      const card = root.querySelector("#ticket")?.closest(".card");
      if (card) card.innerHTML = `<h2>已配对的手机</h2><p class="small muted">额外手机默认只读。管理手机可授予照片管理，不会授予 Codex 执行权。</p>${state.sessions.filter(s => !s.revoked).map(s => `<div class="setting-row"><span>${escape(s.id.slice(0, 8))} · ${s.role === "manager" ? "照片管理" : "只读"}${s.id === state.session.id ? "（当前）" : ""}</span><div>${state.session.role === "manager" && s.id !== state.session.id ? `<button class="secondary" data-phone-id="${s.id}" data-phone-role="${s.role === "manager" ? "viewer" : "manager"}">${s.role === "manager" ? "设为只读" : "授予照片管理"}</button>` : ""}${s.id === state.session.id || state.session.role === "manager" ? `<button class="danger" data-phone-id="${s.id}" data-phone-role="revoke">${s.id === state.session.id ? "撤销本机登录" : "撤销"}</button>` : ""}</div></div>`).join("")}`;
    }
    if (state.page === "settings" && state.session?.role === "operator") {
      for (const phone of state.sessions.filter(s => s.phone && !s.revoked)) {
        const revoke = root.querySelector(`[data-revoke="${phone.id}"]`); if (!revoke) continue;
        const button = document.createElement("button"); button.className = "secondary";
        button.dataset.phoneId = phone.id; button.dataset.phoneRole = phone.role === "manager" ? "viewer" : "manager";
        button.textContent = phone.role === "manager" ? "设为只读" : "授予照片管理";
        revoke.before(button);
        if (phone.role === "manager") {
          const control = document.createElement("button"); control.className = "secondary";
          control.dataset.phoneId = phone.id; control.dataset.phoneRole = phone.codexControl ? "codex-off" : "codex-on";
          control.textContent = phone.codexControl ? "撤销 Codex 控制" : "授权 Codex 控制"; revoke.before(control);
        }
      }
    }
    if (state.session?.role === "viewer") {
      for (const control of root.querySelectorAll("#upload,#save-settings,[data-cover],[data-delete],[data-hidden],[data-rotate]")) control.disabled = true;
    }
    if (state.session?.role !== "operator" && !state.session?.codexControl && state.page === "tasks") {
      for (const control of root.querySelectorAll("form button,form textarea,[data-approval],#interrupt,#quick-interrupt")) control.disabled = true;
      const notice = root.querySelector(".notice"); if (notice) notice.textContent = "当前手机可查看任务。Codex 远程执行需要原有控制端明确授权；照片管理不会自动获得执行权。";
    }
    if (state.session?.role !== "operator") {
      for (const control of root.querySelectorAll("#ticket,#viewer-ticket,#device-ticket")) control.hidden = true;
    }
    root.querySelectorAll(".tag").forEach((el) => {
      if (el.textContent.startsWith("MOCK")) el.textContent = "远程控制";
    });
    const bridgeLabel = root.querySelector(".top-actions > span");
    if (bridgeLabel)
      bridgeLabel.textContent = state.bridgeOnline
        ? state.codex?.online
          ? "电脑与 Codex 在线"
          : "桥接在线 · Codex 尚未就绪"
        : "电脑离线";
    const footer = root.querySelector(".footer span:last-child");
    if (footer) footer.textContent = "受保护的远程控制 · 设备实机状态独立显示";
    if (state.page === "tasks") {
      const notice = root.querySelector(".notice");
      if (notice)
        notice.textContent =
          "指令将在你明确授权的电脑与工作区执行；敏感操作按次审批。";
      const submit = root.querySelector("#task-form button");
      if (submit) submit.textContent = "创建任务 ↗";
      const prompt = root.querySelector("#prompt");
      if (prompt) {
        prompt.placeholder = "输入要在已授权工作区完成的任务";
        const label = document.createElement("label");
        label.textContent = "执行工作区";
        const select = document.createElement("select");
        select.id = "task-workspace";
        select.innerHTML = state.workspaces.map(w => `<option value="${escape(w.id)}">${escape(w.name || w.id)}</option>`).join("");
        if (state.projectId) select.value = state.projectId;
        select.onchange = () => { state.projectId = select.value; };
        prompt.before(label, select);
        const modeLabel = document.createElement("label"), mode = document.createElement("select");
        modeLabel.textContent = "任务权限";
        mode.id = "task-sandbox";
        mode.innerHTML = '<option value="workspace-write">允许修改此工作区 · 敏感操作审批</option><option value="read-only">只读沙箱 · 禁止写入与网络</option>';
        mode.value = state.sandbox;
        mode.onchange = () => { state.sandbox = mode.value; };
        prompt.before(modeLabel, mode);
      }
    }
    if (state.page === "settings" && (state.session?.role === "operator" || state.session?.codexControl)) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "生成电脑一次性授权码";
      button.onclick = async () => {
        try {
          const ticket = await api("bridge/tickets", {});
          const box = document.createElement("div");
          box.className = "notice";
          box.textContent = `电脑安装授权码：${ticket.code}（两分钟有效，仅一次）`;
          button.after(box);
        } catch (e) {
          toast(e.message);
        }
      };
      root.querySelector(".panel-grid").prepend(button);
    }
  }
  if (PREVIEW) {
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.textContent =
      "隔离演示：所有配对、任务、更新与桥接均为 Mock。图片只在当前浏览器内存中处理，不会上传，也不会连接真实 Codex。";
    document.querySelector("main").prepend(notice);
  }
  document.querySelectorAll("[data-page]").forEach(
    (button) =>
      (button.onclick = () => {
        state.page = button.dataset.page;
        if (state.page === "tasks") state.unread = 0;
        render();
        window.scrollTo(0, 0);
      }),
  );
  document
    .querySelectorAll(".quota-fill")
    .forEach((el) => (el.style.width = `${el.dataset.width}%`));
  bind();
  for (const field of root.querySelectorAll("textarea")) {
    const key = `${field.id}:${field.closest("[data-task-context]")?.dataset.taskContext || ""}`;
    if (inputDrafts.has(key)) field.value = inputDrafts.get(key);
  }
  if (editing) { const field = document.getElementById(editing.id); if (field && (field.closest("[data-task-context]")?.dataset.taskContext || "") === editing.context) { field.focus({ preventScroll: true }); field.setSelectionRange(editing.start, editing.end); } }
  canvas = document.querySelector("#screen");
  ctx = canvas?.getContext("2d");
  if (canvas) bindWatch();
}
const dispatchCommand = createCommandDispatcher(data => api("commands", data));
async function command(action, extra = {}) {
  try {
    const result = await dispatchCommand({
      action,
      ...(action === "start" ? {} : { taskId: active()?.id }),
      ...extra,
    });
    if (action === "start") state.selected = result.id;
    if (result.receipt) state.commandReceipts = mergeCommandReceipt(state.commandReceipts, result.receipt);
    renderPreservingFocus();
    toast(state.mode === "production" ? "中转已接收，请查看电脑回执与执行结果" : "模拟指令已接收");
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}
function bind() {
  document.querySelectorAll("[data-phone-id]").forEach(button => {
    button.onclick = async () => {
      try {
        const enabling = button.dataset.phoneRole === "codex-on";
        if (enabling && !confirm("允许此管理手机新建、继续、中断 Codex 任务、按次审批，以及生成 Windows 绑定码？执行仍受电脑工作区授权和官方沙箱限制。照片配对本身不包含这些权限。")) return;
        await api("phone/access", { id: button.dataset.phoneId, role: button.dataset.phoneRole, reviewed: enabling });
        if (button.dataset.phoneId === state.session.id) { state.paired = false; ws?.close(); renderPair(); }
        else { merge(await api("state")); render(); }
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll("[data-hidden],[data-rotate]").forEach(button => {
    button.onclick = async () => {
      try {
        const id = button.dataset.hidden || button.dataset.rotate;
        const patch = button.dataset.hidden ? { eggPhoto: state.settings.eggPhoto === id ? null : id }
          : { defaultPhoto: id, slideshow: true, ...(state.settings.eggPhoto === id ? { eggPhoto: null } : {}) };
        state.settings = await api("settings", patch); render();
        toast(state.deviceOnline ? "已保存，正在同步至挂件" : "已保存，等待挂件联网同步");
      } catch (error) { toast(error.message); }
    };
  });
  const on = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };
  on("task-form", "submit", async (e) => {
    e.preventDefault();
    const text = document.querySelector("#prompt").value;
    if (await command("start", { text,
      projectId: document.querySelector("#task-workspace")?.value || undefined, sandbox: state.sandbox })) {
      inputDrafts.set("prompt:", "");
      if (document.querySelector("#prompt")?.value === text) document.querySelector("#prompt").value = "";
    }
  });
  on("continue-form", "submit", async (e) => {
    e.preventDefault();
    const taskId = active()?.id, text = document.querySelector("#continuation").value;
    if (await command(
      ["thinking", "working", "testing"].includes(active()?.state)
        ? "steer"
        : "continue",
      { text },
    )) {
      inputDrafts.set(`continuation:${taskId}`, "");
      if (active()?.id === taskId && document.querySelector("#continuation")?.value === text) document.querySelector("#continuation").value = "";
    }
  });
  on("interrupt", "click", () => command("interrupt"));
  on("quick-interrupt", "click", () => command("interrupt"));
  document.querySelectorAll("[data-task]").forEach(
    (el) =>
      (el.onclick = () => {
        state.selected = el.dataset.task;
        if (state.mode === "production") api("settings", { codexTaskId: state.selected }).catch(e => toast(e.message));
        render();
      }),
  );
  document.querySelectorAll("[data-decision]").forEach(
    (el) =>
      (el.onclick = () =>
        command("approve", {
          approvalId: active()?.approvalId,
          decision: el.dataset.decision,
          reviewed: el.dataset.decision === "accept" && document.querySelector("#approval-reviewed")?.checked === true,
          approvalDigest: active()?.approval?.digest,
        })),
  );
  on("approval-reviewed", "change", e => {
    reviewedApproval = e.target.checked ? { id: active()?.approvalId, digest: active()?.approval?.digest } : null;
    const button = document.querySelector('[data-decision="accept"]');
    if (button) button.disabled = !e.target.checked;
  });
  document.querySelectorAll("[data-device-control]").forEach(el => {
    el.onclick = async () => {
      const enabled = el.dataset.enabled !== "true";
      if (enabled && !confirm("允许这台挂件新建检查任务、继续、中断，并在屏幕确认后处理本次审批？可随时撤销。")) return;
      try { await api("device/permissions", { id: el.dataset.deviceControl, enabled }); merge(await api("state")); render(); }
      catch (e) { toast(e.message); }
    };
  });
  on("mark-read", "click", () => {
    markRead();
    render();
    toast("已标为已读");
  });
  on("upload", "change", async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (!files.length || photoUploadActive) return;
    const production = state.mode === "production";
    const available = Math.max(0, PHOTO_LIMIT - state.photos.length);
    if (!available) return toast("相册已满，请先删除照片");
    let uploaded = 0;
    let failure = files.length > available ? `相册只剩 ${available} 个位置` : "";
    photoUploadActive = true;
    try {
      const { cropPhoto } = production ? await import("./photo-crop.mjs") : {};
      for (const file of files.slice(0, available)) {
        if (file.size > 8 * 1024 * 1024) {
          failure = "已跳过超过 8 MiB 的照片";
          continue;
        }
        const image = production ? await cropPhoto(file) : file;
        if (!image) continue;
        const response = await fetch("/api/photos", {
          method: "POST",
          headers: {
            "Content-Type": image.type,
            "X-Photo-Name": encodeURIComponent(file.name),
          },
          body: image,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        uploaded++;
      }
    } catch (error) {
      failure = error.message;
    } finally {
      photoUploadActive = false;
    }
    if (uploaded) {
      try { merge(await api("state")); render(); } catch { failure ||= "相册已保存，暂时无法刷新"; }
    }
    if (failure || uploaded) toast(failure || `已保存 ${uploaded} 张照片`);
  });
  document.querySelectorAll("[data-cover]").forEach(
    (el) =>
      (el.onclick = async () => {
        try {
          state.settings = await api("settings", {
            defaultPhoto: el.dataset.cover,
          });
          state.photo = allPhotos().findIndex((p) => p.id === el.dataset.cover);
          render();
          toast("默认封面已保存");
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-delete]").forEach(
    (el) =>
      (el.onclick = async () => {
        try {
          await api(`photos/${el.dataset.delete}`, {}, "DELETE");
          merge(await api("state"));
          state.photo = 0;
          render();
          toast("照片已删除");
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  on("brightness", "input", (e) => {
    document.querySelector("#brightness-value").textContent =
      e.target.value + "%";
  });
  on("volume", "input", (e) => {
    document.querySelector("#volume-value").textContent =
      e.target.value + "%";
  });
  on("save-settings", "click", async () => {
    try {
      state.settings = await api("settings", {
        brightness: Number(document.querySelector("#brightness").value),
        audioSilent: document.querySelector("#audio-silent").checked,
        volume: Number(document.querySelector("#volume").value),
        slideshow: document.querySelector("#slideshow").checked,
        slideSeconds: Number(document.querySelector("#slide-seconds").value),
        border: document.querySelector("#border").value,
        eggMessage: document.querySelector("#egg-message").value,
        eggDate: document.querySelector("#egg-date").value,
        displayMode: document.querySelector("#display-mode").value,
        sleepAfter: Number(document.querySelector("#sleep-after").value),
        eggPhoto: document.querySelector("#egg-photo").value || null,
        utcOffset: -new Date().getTimezoneOffset(),
      });
      render();
      toast("设置已保存");
    } catch (e) {
      toast(e.message);
    }
  });
  const ticket = async (role) => {
    try {
      const result = await api("tickets", { role });
      const el = document.querySelector("#ticket-result");
      el.replaceChildren();
      const img = new Image();
      img.src = result.qr;
      img.className = "qr";
      img.alt = "两分钟一次性配对二维码";
      const link = document.createElement("a");
      link.href = result.link;
      link.textContent = "打开一次性配对链接";
      const note = document.createElement("p");
      note.className = "small muted";
      note.textContent = result.manualCode
        ? `手动配对码 ${result.manualCode} · 两分钟有效，仅限使用一次`
        : "两分钟有效，使用一次后失效";
      el.append(img, document.createElement("br"), link, note);
    } catch (e) {
      toast(e.message);
    }
  };
  on("ticket", "click", () => ticket("operator"));
  on("viewer-ticket", "click", () => ticket("viewer"));
  on("device-ticket", "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { code } = await api("device/tickets", {});
      const url = new URL("/setup/", location.origin);
      url.hash = `device=${code}`;
      location.assign(url);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });
  document.querySelectorAll("[data-revoke]").forEach(
    (el) =>
      (el.onclick = async () => {
        try {
          await api("revoke", { id: el.dataset.revoke });
          if (el.dataset.revoke === state.session.id) {
            state.paired = false;
            renderPair();
          } else {
            merge(await api("state"));
            render();
          }
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  on("disconnect", "click", () => {
    ws?.close();
    toast("连接已断开，稍后将自动重连");
  });
}
function allPhotos() {
  return [0, 1, 2]
    .map((i) => ({ id: `builtin-${i}`, url: asset(`/photos/${i}.jpg`) }))
    .concat(state.photos.filter(p => p.id !== state.settings.eggPhoto).map((p) => ({ ...p, url: photoUrl(p.id) })));
}
function revealEgg() {
  state.egg = true;
  state.eggOpenedAt = performance.now();
}
function switchScreen(screen) {
  watchInteraction = performance.now();
  state.screen = screen;
  state.egg = false;
  render();
}
function bindWatch() {
  document
    .querySelectorAll("[data-screen]")
    .forEach((el) => (el.onclick = () => switchScreen(el.dataset.screen)));
  let startX = 0,
    startY = 0;
  canvas.onpointerdown = (e) => {
    watchInteraction = performance.now();
    startX = e.clientX;
    startY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointerup = (e) => {
    const dx = e.clientX - startX,
      dy = e.clientY - startY;
    if (Math.abs(dx) > 35) {
      switchScreen(nextScreen(state.screen, dx < 0 ? 1 : -1));
      return;
    }
    if (Math.abs(dy) > 35) return;
    if (state.screen === "codex" && Math.abs(dx) <= 12 && Math.abs(dy) <= 12) {
      const bounds = canvas.getBoundingClientRect();
      const x = (e.clientX - bounds.left) / bounds.width * 466;
      const y = (e.clientY - bounds.top) / bounds.height * 466;
      if (x >= 131 && x <= 335 && y >= 106 && y <= 327) miao.tap(performance.now());
      return;
    }
    if (state.egg) {
      state.egg = false;
      return;
    }
    if (state.screen === "photos") {
      state.photo = (state.photo + 1) % allPhotos().length;
      const now = Date.now();
      state.taps = now - state.tapTime < 600 ? state.taps + 1 : 1;
      state.tapTime = now;
      if (state.taps >= 5) {
        revealEgg();
        state.taps = 0;
        if (state.mode !== "production") beep();
      }
    }
  };
  const yellow = document.querySelector("#yellow");
  yellow.onpointerdown = (e) => {
    yellow.setPointerCapture(e.pointerId);
    if (state.mode === "production") {
      switchScreen("muse");
      return;
    }
    state.listening = true;
    state.screen = "muse";
    state.muse = "MOCK · 正在听你说话…";
    document
      .querySelectorAll("[data-screen]")
      .forEach((el) =>
        el.classList.toggle("selected", el.dataset.screen === "muse"),
      );
    beep();
  };
  const release = () => {
    if (!state.listening) return;
    state.listening = false;
    if (!state.wifi) {
      state.muse = "Wi-Fi 离线 · 未发送";
      return;
    }
    state.muse = "MOCK · 正在想一想…";
    setTimeout(() => {
      state.muse = "MOCK 回复：今天也有好事发生。";
    }, 1000);
  };
  yellow.onpointerup = release;
  yellow.onpointercancel = release;
  yellow.onlostpointercapture = release;
  document.querySelector("#blue").onclick = () =>
    toast(state.mode === "production" ? "音量请在挂件上调整" : "Mock：已切换语音静音状态");
  document.querySelector("#charging").onchange = (e) => {
    state.charging = e.target.checked;
  };
  document.querySelector("#wifi").onchange = (e) => {
    state.wifi = e.target.checked;
  };
  document.querySelector("#battery").oninput = (e) => {
    state.battery = Number(e.target.value);
    document.querySelector(".battery-value").textContent = state.battery + "%";
  };
}
function beep() {
  try {
    audio ||= new AudioContext();
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.035;
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15);
    osc.stop(audio.currentTime + 0.16);
  } catch {}
}
function text(value, x, y, size = 20, color = "#eff3e5", align = "center") {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.font = `${size}px "Segoe UI","Microsoft YaHei",sans-serif`;
  ctx.fillText(value, x, y);
}
function wrap(value, x, y, width, size = 20, color = "#eff3e5") {
  let line = "",
    row = 0;
  for (const char of value) {
    if (ctx.measureText(line + char).width > width) {
      text(line, x, y + row * size * 1.6, size, color);
      line = char;
      row++;
    } else line += char;
  }
  text(line, x, y + row * size * 1.6, size, color);
}
function cachedPhoto(url) {
  let image = photoImages.get(url);
  if (!image) {
    image = new Image();
    image.src = url;
    photoImages.set(url, image);
  }
  return image;
}
function drawMiaoStill() {
  const still = miao.image(0);
  if (still.complete && still.naturalWidth) ctx.drawImage(still, 131, 106, 204, 221);
}
function draw() {
  requestAnimationFrame(draw);
  state.tick++;
  if (!ctx || !canvas?.isConnected) return;
  const now = performance.now();
  const policy = powerPolicy({
    charging: state.charging,
    battery: state.battery,
    screen: state.screen,
    brightness: state.settings.brightness,
    displayMode: state.settings.displayMode,
    sleepAfter: state.settings.sleepAfter,
    idleSeconds: (now - watchInteraction) / 1000,
  });
  const label = !policy.display
    ? "屏幕已休眠"
    : state.egg
      ? `彩蛋：${state.settings.eggMessage}`
      : state.screen === "muse"
        ? state.muse
        : state.screen === "codex"
          ? `Codex：${labels[active()?.state || "idle"]}`
          : state.screen === "photos"
            ? `照片封面 ${state.photo + 1}`
            : "中文使用指南";
  if (canvas.getAttribute("aria-label") !== label)
    canvas.setAttribute("aria-label", label);
  if (now - lastDraw < 1000 / (state.charging ? 12 : policy.refreshHz)) return;
  lastDraw = now;
  ctx.clearRect(0, 0, 466, 466);
  ctx.fillStyle = "#122521";
  ctx.fillRect(0, 0, 466, 466);
  if (!policy.display) {
    text("屏幕已休眠", 233, 225, 24, "#567568");
    text("模拟低电量 · 连接充电唤醒", 233, 260, 15, "#456052");
    return;
  }
  ctx.save();
  if (state.charging) {
    ctx.translate(
      Math.sin(state.tick / 170) * 2,
      Math.cos(state.tick / 180) * 2,
    );
  }
  if (state.egg) {
    const hidden = state.settings.eggPhoto && cachedPhoto(photoUrl(state.settings.eggPhoto));
    if (hidden?.complete && hidden.naturalWidth) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (now - state.eggOpenedAt) / 450);
      ctx.drawImage(hidden, 0, 0, 466, 466);
      ctx.fillStyle = "#11252166";
      ctx.fillRect(0, 0, 466, 466);
      ctx.restore();
    } else drawMiaoStill();
    text("给特别的你", 233, 120, 26, "#ebd28a");
    ctx.font = "19px sans-serif";
    wrap(state.settings.eggMessage, 233, 350, 285, 19, "#e5e9cf");
    text("轻点返回", 233, 420, 13, "#bfd4bf");
  } else if (state.screen === "photos") {
    const photos = allPhotos();
    if (
      state.settings.slideshow &&
      Date.now() - lastSlide > state.settings.slideSeconds * 1000
    ) {
      state.photo = (state.photo + 1) % photos.length;
      lastSlide = Date.now();
    }
    const photo = photos[(state.photo + photos.length) % photos.length];
    const img = cachedPhoto(photo.url);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, 466, 466);
    const shade = ctx.createLinearGradient(0, 250, 0, 466);
    shade.addColorStop(0, "#0000");
    shade.addColorStop(1, "#071d21d9");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 250, 466, 216);
    text(photo.name || "", 233, 371, 28, "#eff2de");
    text(
      `${(state.photo % photos.length) + 1} / ${photos.length}`,
      233,
      402,
      13,
      "#d1dec6",
    );
  } else if (state.screen === "codex") {
    const task = active(),
      status =
        !state.wifi || !state.bridgeOnline || (state.mode === "production" && !state.codex?.online)
          ? "offline" : task?.state || "idle";
    text("CODEX COMPANION", 233, 85, 14, "#96b29b");
    miao.draw(ctx, 131, 106, 204, status, task?.id, state.charging, now);
    text(labels[status], 233, 365, 25);
    text(
      task?.title.slice(0, 18) || "随时准备接住你的灵感",
      233,
      402,
      14,
      "#88a68f",
    );
  } else if (state.screen === "muse") {
    text("MUSE", 233, 87, 20, "#c0cdb0");
    drawMiaoStill();
    ctx.font = "20px sans-serif";
    wrap(
      !state.wifi ? "Wi-Fi 离线" : state.mode === "production" ? "请在挂件上操作 Muse" : state.muse,
      233,
      360,
      290,
      20,
    );
    text(state.mode === "production" ? "账号状态请查看挂件设置" : "未授权真实账号 · MOCK", 233, 420, 12, "#809b83");
  } else {
    text("使用小指南", 233, 95, 28, "#e1d89b");
    [
      ["01", "左右滑动，切换界面"],
      ["02", "轻点封面，换一张照片"],
      ["03", "黄键按住说话，松开发送"],
      ["04", "五次轻点，发现小惊喜"],
    ].forEach(([n, v], i) => {
      text(n, 105, 165 + i * 49, 14, "#a1b694");
      text(v, 246, 165 + i * 49, 18);
    });
    text("完整说明见控制台「使用指南」", 233, 393, 14, "#92aa8d");
  }
  text(
    `${state.wifi ? "●" : "○"}  ${state.charging ? "ϟ " : ""}${state.battery}%`,
    233,
    45,
    12,
    "#e1e9ce",
  );
  ctx.restore();
  if (state.settings.border !== "none") {
    ctx.strokeStyle = state.settings.border === "gold" ? "#e6c56c" : "#b4c59b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(233, 233, 225, 0, Math.PI * 2);
    ctx.stroke();
  }
  const todayDate = new Date();
  const today = `${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
  if (
    state.screen === "photos" &&
    today === state.settings.eggDate &&
    !sessionStorage.getItem("sw-date-egg")
  ) {
    revealEgg();
    sessionStorage.setItem("sw-date-egg", "1");
  }
}
boot();
requestAnimationFrame(draw);
