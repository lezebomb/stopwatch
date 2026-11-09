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
watchVersion(
  typeof __SW_BUILD_ID__ === "undefined" ? "local" : __SW_BUILD_ID__,
);
const PREVIEW = typeof __SW_PREVIEW__ !== "undefined" && __SW_PREVIEW__;
const demo = PREVIEW ? await installDemo() : null;
const asset = (p) => new URL(p.replace(/^\//, ""), import.meta.url).href;
const photoUrl = (id) =>
  PREVIEW ? demo.photoUrl(id) : `/api/photos/${id}.jpg`;
const root = document.querySelector("#app");
let photoUploadActive = false;
const state = {
  paired: false,
  mode: "mock",
  page: location.pathname === "/simulator" ? "overview" : "overview",
  tasks: [],
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
  [...state.tasks].sort((a, b) => b.updated - a.updated)[0];
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
  const response = await fetch(
    `/api/${route}`,
    data === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
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
  ])
    if (snapshot[key] != null) state[key] = snapshot[key];
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
  root.innerHTML = `<main class="pair-page"><section class="pair-card"><div class="brand"><span class="brandmark"></span>StopWatch</div><div class="eyebrow">A LITTLE COMPANION, ALWAYS NEAR</div><h1>让陪伴，从这里开始。</h1><p>在启动服务的电脑上找到两分钟有效的配对链接，直接打开；也可以粘贴一次性配对码。</p><form id="pair-form"><label for="pair-code">一次性配对码</label><input id="pair-code" autocomplete="off" required placeholder="粘贴电脑显示的短时配对码"><button>连接我的 StopWatch</button></form><p class="small">当前为本地 MOCK 预览 · 无需 Muse / Codex 账号<br>二维码不会包含长期控制密钥。</p></section></main>`;
  if (state.mode === "production") {
    const paragraphs = root.querySelectorAll(".pair-card p");
    paragraphs[0].textContent =
      "扫描设备或已授权控制台的短时二维码，完成一次性绑定。";
    paragraphs[1].textContent =
      "受保护的正式控制台；长期密钥不会放在二维码中。";
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
      else if (data.type === "bridge") {
        const deviceOnline = typeof data.deviceOnline === "boolean" ? data.deviceOnline : state.deviceOnline;
        if (state.bridgeOnline === data.online && state.deviceOnline === deviceOnline) return;
        state.bridgeOnline = data.online;
        state.deviceOnline = deviceOnline;
        render();
      }
    } catch {}
  };
  ws.onclose = (event) => {
    state.connected = false;
    if (event.code === 4001) {
      state.paired = false;
      renderPair();
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
  if (event.type === "bridgeStatus") state.codex = event.payload;
  if (event.type === "settings") state.settings = event.payload;
  if (event.type === "photos") state.photos = event.payload.photos;
  if (event.type === "commandError" && !silent) toast(event.payload.message);
  if (!silent) renderPreservingFocus();
}
function renderPreservingFocus() {
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
    : '<div class="empty">还没有任务消息。发一条指令，<br>看看小伙伴如何忙起来。</div>';
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
  return `<section class="card"><div class="card-head"><h2>Codex 正在做什么</h2><span class="tag">MOCK</span></div>${task ? `<div class="task-project">${escape(task.project)}</div><h3 class="task-title">${escape(task.title)}</h3><span class="task-status"><i class="dot"></i>${labels[task.state] || task.state}</span><p class="task-operation">${escape(task.operation)}</p><div class="progress-path" aria-label="任务阶段，不表示百分比">${[0, 1, 2, 3].map((i) => `<i class="${i <= stage ? "on" : ""}"></i>`).join("")}</div><div class="actions"><button data-page="tasks">查看任务详情 ↗</button>${["thinking", "working", "testing", "approval"].includes(task.state) ? '<button class="quiet" id="quick-interrupt">中断</button>' : ""}</div>` : `<h3 class="task-title">小伙伴准备好开工了。</h3><p class="task-operation">从手机发一条指令，在这里看它思考、测试与庆祝。</p><div class="actions"><button data-page="tasks">创建第一个任务 ↗</button><span class="task-status">${state.bridgeOnline ? "Mock 桥接在线" : "等待桥接连接"}</span></div>`}</section>`;
}
function quotaCard() {
  return `<section class="card"><div class="card-head"><h2>额度小看板</h2><span class="tag">模拟额度</span></div><div class="quota-row">${[
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
function overview() {
  return `<div class="dashboard">${watchCard()}<div class="right-stack">${taskCard()}${quotaCard()}</div></div><div class="bottom-grid"><section class="card"><div class="card-head"><h2>把喜欢的瞬间带在身边</h2><button class="text-button" data-page="photos">管理照片 ↗</button></div><div class="mini-photos">${[0, 1, 2].map((i) => `<img class="photo-thumb" src="${asset(`/photos/${i}.jpg`)}" alt="自制风景测试图片 ${i + 1}">`).join("")}${state.photos
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
  return `<div class="notice">MOCK 演示：任务不会调用真实 Codex。输入“审批”体验确认流程，输入“失败”体验异常。</div><div class="panel-grid"><div><section class="card"><div class="card-head"><h2>发一条新指令</h2><span class="tag">MOCK</span></div><form id="task-form"><label for="prompt">想让小伙伴做什么？</label><textarea id="prompt" required maxlength="8000" placeholder="例如：检查照片上传，运行测试并申请审批"></textarea><p class="muted small">可使用手机系统输入法的语音转文字。</p><button>创建 Mock 任务 ↗</button></form></section><h2 class="list-heading">会话与项目</h2><div class="task-list">${
    [...state.tasks]
      .reverse()
      .map(
        (t) =>
          `<button data-task="${escape(t.id)}" class="${task?.id === t.id ? "selected" : ""}">${escape(t.title)}<span class="muted">${escape(t.project)} · ${labels[t.state]}</span></button>`,
      )
      .join("") || '<p class="empty">还没有会话</p>'
  }</div></div><section class="card"><div class="card-head"><h2>任务详情</h2><span class="task-status">${task ? labels[task.state] : "等待第一条指令"}</span></div>${
    task
      ? `<h3 class="task-title">${escape(task.title)}</h3><p class="muted small">${escape(task.operation)}</p>${task.state === "approval" ? `<div class="approval"><strong>请确认本次模拟操作</strong><code>${escape(task.approval?.command)}</code><p class="small">${escape(task.approval?.reason)}</p><div class="actions"><button data-decision="accept">批准本次</button><button class="danger" data-decision="decline">拒绝</button></div></div>` : ""}${task.result ? `<div class="result">${escape(task.result)}</div>` : ""}<div class="timeline">${taskEvents()
          .filter((e) => e.payload.id === task.id)
          .slice(0, 8)
          .map(
            (e) =>
              `<div class="event-row"><span class="event-mark"></span><div>${escape(e.payload.operation)}<span class="event-time">${time(e.time || Date.now())}</span></div></div>`,
          )
          .join(
            "",
          )}</div><form id="continue-form"><label for="continuation">${running ? "追加指令" : "继续这个会话"}</label><textarea id="continuation" required maxlength="8000" placeholder="输入后续要求"></textarea><div class="actions"><button ${task.state === "approval" ? "disabled" : ""}>${running ? "追加到当前任务" : "继续任务"}</button><button type="button" class="danger" id="interrupt" ${!running && task.state !== "approval" ? "disabled" : ""}>中断任务</button></div></form>`
      : '<div class="empty">创建一个任务后，可以在这里查看执行过程、最终结果，以及需要你确认的操作。</div>'
  }</section></div>`;
}
function photos() {
  const bytes = state.photos.reduce((sum, p) => sum + p.bytes, 0);
  const production = state.mode === "production";
  return `<div class="notice">${production ? "绑定后的挂件联网时自动同步。离线时继续显示已有照片。" : "本地演示相册。"}</div><div class="stat-line"><span>${state.photos.length} / 12 张</span><span>${(bytes / 1024 / 1024).toFixed(2)} / 6 MiB</span></div><div class="upload"><h2>为小小屏幕，留住大大的喜欢。</h2><p class="muted small">${production ? "可预览圆屏并调整裁切" : "自动居中裁切与缩放"} · JPG / PNG / WebP · 单张最多 8 MiB</p><label for="upload">选择照片</label><input type="file" id="upload" accept="image/jpeg,image/png,image/webp" ${production ? "multiple" : ""}></div><div class="photo-grid">${[
    0, 1, 2,
  ]
    .map((i) => ({
      id: `builtin-${i}`,
      name: ["山间的晚风", "海边的日落", "夜空的一颗星"][i],
      builtin: true,
    }))
    .concat(state.photos)
    .map(
      (p) =>
        `<article class="photo-tile"><img src="${p.builtin ? asset(`/photos/${p.id.slice(-1)}.jpg`) : photoUrl(p.id)}" alt="${escape(p.name)}"><p>${escape(p.name)} ${state.settings.defaultPhoto === p.id ? "· 当前封面" : ""}</p><div class="actions"><button class="secondary" data-cover="${p.id}">设为封面</button>${!p.builtin ? `<button class="danger" data-delete="${p.id}">删除</button>` : ""}</div></article>`,
    )
    .join("")}</div>`;
}
function settings() {
  const production = state.mode === "production";
  const canPair = production && state.session?.role === "operator";
  const roleName = { operator: "可控制", viewer: "只读", bridge: "Windows 桥接", device: "StopWatch 挂件" };
  return `<div class="panel-grid"><section class="card"><h2>让陪伴，刚刚好。</h2><div class="setting-row"><span>${production ? "挂件亮度" : "模拟屏幕亮度"} <strong id="brightness-value">${state.settings.brightness}%</strong></span><input id="brightness" type="range" min="10" max="80" step="5" value="${state.settings.brightness}" aria-label="亮度"></div><div class="setting-row"><span>照片自动轮播</span><input id="slideshow" type="checkbox" ${state.settings.slideshow ? "checked" : ""}></div><label for="slide-seconds">轮播间隔（秒）</label><input id="slide-seconds" type="number" min="5" max="300" value="${state.settings.slideSeconds}"><label for="border">封面装饰边框</label><select id="border"><option value="mint" ${state.settings.border === "mint" ? "selected" : ""}>薄荷绿</option><option value="gold" ${state.settings.border === "gold" ? "selected" : ""}>暖金色</option><option value="none" ${state.settings.border === "none" ? "selected" : ""}>无边框</option></select><label for="egg-message">留给 TA 的彩蛋留言</label><textarea id="egg-message" maxlength="150">${escape(state.settings.eggMessage)}</textarea><label for="egg-date">纪念日（MM-DD）</label><input id="egg-date" value="${escape(state.settings.eggDate)}" maxlength="5"><button id="save-settings">保存设置</button></section><div class="right-stack"><section class="card"><h2>配对与设备授权</h2><p class="small muted">授权链接两分钟有效，使用一次后失效。</p><div class="actions"><button id="ticket">新建控制端二维码</button><button class="secondary" id="viewer-ticket">新建只读端</button>${canPair ? '<button class="secondary" id="device-ticket">绑定 StopWatch</button>' : ""}</div><div id="ticket-result"></div><h3 class="list-heading">已授权设备与浏览器</h3>${state.sessions
    .filter((s) => !s.revoked)
    .map(
      (s) =>
        `<div class="setting-row"><span>${escape(s.id.slice(0, 8))} · ${roleName[s.role] || "其他"} ${s.id === state.session?.id ? "（当前）" : ""}</span><button class="danger" data-revoke="${s.id}">撤销</button></div>`,
    )
    .join(
      "",
    )}</section><section class="card"><h2>连接情况</h2><p class="small muted">中转服务：${state.connected ? "在线" : "重连中"}<br>Windows ${production ? "" : "Mock "}桥接：${state.bridgeOnline ? "在线" : "离线"}<br>StopWatch 实物：${state.connected && state.deviceOnline ? "最近已同步" : "暂无在线挂件"}</p><button class="quiet" id="disconnect">重新连接</button></section></div></div>`;
}
function guidePage() {
  return `<div class="guide-grid">${guide.map(([title, text], i) => `<article class="guide-card"><div class="number">GUIDE / ${String(i + 1).padStart(2, "0")}</div><h2>${title}</h2><p>${text}</p></article>`).join("")}</div>`;
}
function render() {
  if (!state.paired) return;
  if (state.page === "tasks") markRead();
  const nav = [
    ["overview", "◉", "陪伴总览"],
    ["tasks", "⌘", "Codex 任务"],
    ["photos", "▧", "照片时光"],
    ["settings", "⚙", "设备设置"],
    ["guide", "☷", "使用指南"],
  ];
  const titles = {
    overview: ["一切都在，慢慢来。", "照片、灵感，还有正在认真工作的小伙伴。"],
    tasks: ["你的灵感，它来接住。", "从一条指令开始，把正在发生的事看得清楚。"],
    photos: ["喜欢的瞬间，随身带着。", "让每一次抬眼，都看见一点喜欢。"],
    settings: [
      "让它，更像你的伙伴。",
      "调整日常偏好，为未来的礼物留一点惊喜。",
    ],
    guide: ["第一次用，也没关系。", "关于这位小伙伴，你需要知道的小事。"],
  };
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark"></span>StopWatch</div><div class="brand-note">小小挂件 · 长长陪伴</div><nav class="nav" aria-label="主导航">${nav.map(([key, icon, title]) => `<button data-page="${key}" class="${state.page === key ? "active" : ""}"><span class="nav-icon">${icon}</span>${title}${key === "tasks" && state.unread ? `<span class="unread">${state.unread}</span>` : ""}</button>`).join("")}</nav><div class="side-bottom"><strong>MADE FOR SOMEONE SPECIAL</strong>把日常的一点温柔，<br>装进 466 像素的圆里。<p class="small muted">v${VERSION}</p></div></aside><main class="main"><header class="topbar"><span class="muted">WORKSPACE / 我的小小陪伴</span><div class="top-actions"><span><i class="dot ${state.bridgeOnline ? "" : "off"}"></i> ${state.bridgeOnline ? "Mock 桥接在线" : "桥接离线"}</span><span class="tag">MOCK PREVIEW</span><span class="avatar">S</span></div></header><div class="pagehead"><div><div class="eyebrow">${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })} · A LITTLE MOMENT</div><h1>${titles[state.page][0]}</h1><p>${titles[state.page][1]}</p></div><button class="quiet" data-page="guide">快速上手 ↗</button></div>${!state.connected ? '<div class="offline-banner">事件连接已断开，正在自动重连。任务历史仍保留在电脑上。</div>' : ""}${{ overview, tasks, photos, settings, guide: guidePage }[state.page]()}<footer class="footer"><span>StopWatch Companion · 为日常留一点温柔</span><span>本地模拟 · 未连接真实硬件与账号</span></footer></main></div>`;
  if (state.mode === "production") {
    root.querySelectorAll(".tag").forEach((el) => {
      el.textContent = el.textContent.includes("额度")
        ? "实际额度接口"
        : "远程控制";
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
    }
    if (state.page === "settings") {
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
  canvas = document.querySelector("#screen");
  ctx = canvas?.getContext("2d");
  if (canvas) bindWatch();
}
async function command(action, extra = {}) {
  try {
    await api("commands", {
      id: crypto.randomUUID(),
      action,
      taskId: active()?.id,
      ...extra,
    });
    toast(state.bridgeOnline ? "已发送到 Mock 桥接" : "已排队，桥接恢复后发送");
  } catch (e) {
    toast(e.message);
  }
}
function bind() {
  const on = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };
  on("task-form", "submit", (e) => {
    e.preventDefault();
    command("start", { text: document.querySelector("#prompt").value });
    document.querySelector("#prompt").value = "";
  });
  on("continue-form", "submit", (e) => {
    e.preventDefault();
    command(
      ["thinking", "working", "testing"].includes(active()?.state)
        ? "steer"
        : "continue",
      { text: document.querySelector("#continuation").value },
    );
    document.querySelector("#continuation").value = "";
  });
  on("interrupt", "click", () => command("interrupt"));
  on("quick-interrupt", "click", () => command("interrupt"));
  document.querySelectorAll("[data-task]").forEach(
    (el) =>
      (el.onclick = () => {
        state.selected = el.dataset.task;
        render();
      }),
  );
  document.querySelectorAll("[data-decision]").forEach(
    (el) =>
      (el.onclick = () =>
        command("approve", {
          approvalId: active()?.approvalId,
          decision: el.dataset.decision,
        })),
  );
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
  on("save-settings", "click", async () => {
    try {
      state.settings = await api("settings", {
        brightness: Number(document.querySelector("#brightness").value),
        slideshow: document.querySelector("#slideshow").checked,
        slideSeconds: Number(document.querySelector("#slide-seconds").value),
        border: document.querySelector("#border").value,
        eggMessage: document.querySelector("#egg-message").value,
        eggDate: document.querySelector("#egg-date").value,
      });
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
      note.textContent = "两分钟有效，使用一次后失效 · 本机地址";
      el.append(img, document.createElement("br"), link, note);
    } catch (e) {
      toast(e.message);
    }
  };
  on("ticket", "click", () => ticket("operator"));
  on("viewer-ticket", "click", () => ticket("viewer"));
  on("device-ticket", "click", async () => {
    try {
      const { code } = await api("device/tickets", {});
      const link = document.createElement("a");
      const url = new URL("/setup/", location.origin);
      url.hash = `device=${code}`;
      link.href = url;
      link.textContent = "打开手机蓝牙授权";
      const note = document.createElement("p");
      note.className = "small muted";
      note.textContent = "先让挂件连上 Wi-Fi，然后打开挂件的「手机配网」。请在两分钟内打开此链接授权。";
      document.querySelector("#ticket-result")?.replaceChildren(link, note);
    } catch (error) { toast(error.message); }
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
    .concat(state.photos.map((p) => ({ ...p, url: photoUrl(p.id) })));
}
function switchScreen(screen) {
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
        state.egg = true;
        state.taps = 0;
        beep();
      }
    }
  };
  const yellow = document.querySelector("#yellow");
  yellow.onpointerdown = (e) => {
    yellow.setPointerCapture(e.pointerId);
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
    toast("Mock：已切换语音静音状态");
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
function pet(status) {
  const t = state.tick,
    bounce =
      status === "completed" ? Math.sin(t * 0.12) * 8 : Math.sin(t * 0.04) * 3;
  ctx.save();
  ctx.translate(233, 218 + bounce);
  ctx.fillStyle = "#e3e6d0";
  ctx.beginPath();
  ctx.ellipse(0, 8, 79, 65, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-67, -23);
  ctx.lineTo(-58, -80);
  ctx.lineTo(-19, -51);
  ctx.moveTo(20, -51);
  ctx.lineTo(59, -80);
  ctx.lineTo(68, -23);
  ctx.fill();
  ctx.fillStyle = "#263d37";
  const blink = t % 100 < 5 ? 2 : 9;
  for (const x of [-29, 29]) {
    ctx.beginPath();
    ctx.ellipse(x, 2, 6, blink, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#263d37";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 19, 9, 0, Math.PI);
  ctx.stroke();
  ctx.fillStyle = "#e6aa83";
  for (const x of [-49, 49]) {
    ctx.beginPath();
    ctx.ellipse(x, 20, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#adc79c";
  ctx.beginPath();
  ctx.ellipse(-68, 75, 20, 12, -0.3, 0, Math.PI * 2);
  ctx.ellipse(68, 75, 20, 12, 0.3, 0, Math.PI * 2);
  ctx.fill();
  if (["working", "testing", "thinking"].includes(status)) {
    ctx.fillStyle = "#8da08b";
    ctx.fillRect(-64, 52, 128, 61);
    ctx.fillStyle = "#bbceaa";
    ctx.fillRect(-54, 60, 108, 40);
    text(
      status === "testing"
        ? "✓ _ ✓"
        : status === "thinking"
          ? "· · ·"
          : "{   }",
      0,
      90,
      23,
      "#425d47",
    );
    ctx.fillStyle = "#567058";
    ctx.fillRect(-78, 110, 156, 8);
  }
  if (status === "approval" || status === "failed")
    text("!", 80, -45, 39, "#edc46f");
  if (status === "completed") {
    text("✦", -98, -40, 36, "#e9c879");
    text("✦", 99, -21, 28, "#e9c879");
  }
  ctx.restore();
}
function draw() {
  requestAnimationFrame(draw);
  state.tick++;
  if (!ctx || !canvas?.isConnected) return;
  const policy = powerPolicy({
    charging: state.charging,
    battery: state.battery,
    screen: state.screen,
    brightness: state.settings.brightness,
  });
  const label = !policy.display
    ? "屏幕已休眠"
    : state.egg
      ? `彩蛋：${state.settings.eggMessage}`
      : state.screen === "muse"
        ? state.muse
        : state.screen === "codex"
          ? `Codex Mock：${labels[active()?.state || "idle"]}`
          : state.screen === "photos"
            ? `照片封面 ${state.photo + 1}`
            : "中文使用指南";
  if (canvas.getAttribute("aria-label") !== label)
    canvas.setAttribute("aria-label", label);
  const now = performance.now();
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
    text("给特别的你", 233, 120, 26, "#ebd28a");
    pet("completed");
    ctx.font = "19px sans-serif";
    wrap(state.settings.eggMessage, 233, 350, 285, 19, "#e5e9cf");
    text("轻点返回 · 彩蛋演示", 233, 420, 13, "#7d9b86");
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
    let img = photoImages.get(photo.url);
    if (!img) {
      img = new Image();
      img.src = photo.url;
      photoImages.set(photo.url, img);
    }
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, 466, 466);
    const shade = ctx.createLinearGradient(0, 250, 0, 466);
    shade.addColorStop(0, "#0000");
    shade.addColorStop(1, "#071d21d9");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 250, 466, 216);
    text("LITTLE MOMENTS", 233, 335, 13, "#eff2de");
    text(
      ["山间的晚风", "海边的日落", "夜空的一颗星"][state.photo] ||
        "你喜欢的瞬间",
      233,
      371,
      28,
    );
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
        !state.wifi || !state.bridgeOnline ? "offline" : task?.state || "idle";
    text("CODEX COMPANION", 233, 85, 14, "#96b29b");
    pet(status);
    text(labels[status], 233, 365, 25);
    text(
      "MOCK · " + (task?.title.slice(0, 18) || "随时准备接住你的灵感"),
      233,
      402,
      14,
      "#88a68f",
    );
  } else if (state.screen === "muse") {
    text("MUSE", 233, 87, 20, "#c0cdb0");
    pet(state.listening ? "working" : "idle");
    ctx.font = "20px sans-serif";
    wrap(
      !state.wifi ? "Wi-Fi 离线 · Mock 对话暂停" : state.muse,
      233,
      360,
      290,
      20,
    );
    text("未授权真实账号 · MOCK", 233, 420, 12, "#809b83");
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
    today === state.settings.eggDate &&
    !sessionStorage.getItem("sw-date-egg")
  ) {
    state.egg = true;
    sessionStorage.setItem("sw-date-egg", "1");
  }
}
boot();
requestAnimationFrame(draw);
