export const PROTOCOL = 1;
export const SCREENS = ["photos", "muse", "codex", "guide"];
export const STATES = [
  "offline",
  "idle",
  "thinking",
  "working",
  "testing",
  "approval",
  "completed",
  "failed",
  "interrupted",
];
export const PHOTO_BYTES = 466 * 466 * 2;
export const PHOTO_LIMIT = 12;
export const PHOTO_BUDGET = 6 * 1024 * 1024;
export const labels = {
  offline: "离线",
  idle: "休息一下",
  thinking: "正在思考",
  working: "认真工作中",
  testing: "运行测试",
  approval: "等待你的确认",
  completed: "任务完成啦",
  failed: "需要看一看",
  interrupted: "已中断",
};
export const defaultSettings = {
  brightness: 30,
  slideshow: false,
  slideSeconds: 20,
  border: "mint",
  defaultPhoto: "builtin-0",
  eggMessage: "今天也要记得给自己放个小假。",
  eggDate: "12-25",
  eggPhoto: null,
  displayMode: "photo",
  sleepAfter: 180,
  utcOffset: 480,
  firstRun: true,
  realtimeVoice: false,
};
export function powerPolicy({
  charging = false,
  battery = 80,
  screen = "photos",
  idleSeconds = 0,
  brightness = 30,
  displayMode = "photo",
  sleepAfter = 180,
}) {
  const low = battery >= 0 && battery <= 15;
  const critical = battery >= 0 && battery <= 5;
  const timeout = displayMode === "endurance" ? Math.min(sleepAfter || 90, 90) : sleepAfter;
  const asleep = !charging && (critical || (displayMode !== "photo" && timeout > 0 && idleSeconds >= timeout));
  const desired = Math.max(10, Math.min(80, brightness));
  const batteryCap = displayMode === "endurance" ? 12 : displayMode === "smart" && idleSeconds >= 30
    ? idleSeconds >= 60 ? 10 : 14 : low ? 15 : 20;
  return {
    state: asleep
      ? "screen-off-light-sleep"
      : charging
        ? "charging-display"
        : low
          ? "battery-low"
          : "battery-display",
    display: !asleep,
    brightness: asleep
      ? 0
      : charging
          ? desired
          : Math.min(batteryCap, desired),
    wifi: !asleep && (screen === "muse" || screen === "codex"),
    refreshHz: screen === "photos" ? 1 : 12,
    pixelShift: charging,
    deepSleep: false,
  };
}
export function validEvent(event) {
  return (
    !!event &&
    event.v === PROTOCOL &&
    typeof event.id === "string" &&
    event.id.length < 100 &&
    typeof event.type === "string" &&
    event.type.length < 80 &&
    event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
  );
}
export function nextScreen(current, direction = 1) {
  return SCREENS[
    (SCREENS.indexOf(current) + direction + SCREENS.length) % SCREENS.length
  ];
}
