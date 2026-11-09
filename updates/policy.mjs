export const updateDefaults = {
  checkSeconds: 21600,
  reconnectSeconds: 1800,
  retrySeconds: 60,
  maxRetrySeconds: 21600,
  minBattery: 40,
  stableSeconds: 60,
  idleSeconds: 30,
};
export function updateDecision(
  {
    now,
    lastCheck = 0,
    nextAttempt = 0,
    connected = false,
    charging = false,
    battery = -1,
    busy = false,
    stableFor = 0,
    idleFor = 0,
    manual = false,
    reconnected = false,
  },
  settings = {},
) {
  const c = { ...updateDefaults, ...settings };
  if (!connected) return "offline";
  if (busy) return "busy";
  if (stableFor < c.stableSeconds) return "unstable";
  if (now < nextAttempt) return "backoff";
  if (!manual && !charging && !reconnected) return "battery-no-poll";
  if (
    !manual &&
    !nextAttempt &&
    lastCheck &&
    now - lastCheck < (reconnected ? c.reconnectSeconds : c.checkSeconds)
  )
    return "rate-limited";
  if (!charging || battery < c.minBattery || idleFor < c.idleSeconds)
    return "check-only";
  return "install";
}
export function retryDelay(failures, settings = {}, jitter = 0) {
  const c = { ...updateDefaults, ...settings };
  return (
    Math.min(
      c.maxRetrySeconds,
      c.retrySeconds * 2 ** Math.min(Math.max(0, failures - 1), 12),
    ) + Math.floor(Math.max(0, Math.min(1, jitter)) * 30)
  );
}
