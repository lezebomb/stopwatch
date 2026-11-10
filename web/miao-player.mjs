import data from "../.deps/miao-pack/web.json" with { type: "json" };

const randomWait = ([min, max]) => min + Math.random() * (max - min);
function choose(choices) {
  let value = Math.random();
  for (const { action, weight } of choices) {
    value -= weight;
    if (value < 0) return action;
  }
  return choices.at(-1).action;
}

export class MiaoPlayer {
  constructor(asset) {
    this.asset = asset;
    this.cache = new Map();
    this.nextWash = 0;
    this.current = 0;
    this.lastTap = -Infinity;
  }
  image(id) {
    let image = this.cache.get(id);
    if (!image) {
      image = new Image();
      image.src = this.asset(`miao/${data.assetVersion}/${id}.webp`);
    }
    this.cache.delete(id);
    this.cache.set(id, image);
    if (this.cache.size > 7) this.cache.delete([...this.cache.keys()].find(key => key !== 0));
    return image;
  }
  start(action, now) {
    this.action = action;
    this.step = this.repeated = 0;
    this.due = now;
  }
  rest(now, charging) {
    this.start(null, now);
    this.current = 0;
    this.due += randomWait(data.idleMs) * (charging ? 1 : 3);
  }
  tap(now) {
    if (this.action || now - this.lastTap < data.cooldown) return;
    this.lastTap = now;
    this.start(choose(data.touch), now);
  }
  draw(ctx, x, y, width, status, key, charging, now) {
    if (status !== this.status || key !== this.key) {
      this.status = status;
      this.key = key;
      this.alternate = 0;
      const first = data.stateMap[status]?.[0] || "idle";
      this.nextWash ||= now + randomWait(data.specialMs);
      const terminal = ["completed", "failed"].includes(status) ? `${status}:${key}` : null;
      if (first === "idle" || (terminal && this.terminal === terminal)) this.rest(now, charging);
      else {
        if (terminal) this.terminal = terminal;
        this.alternate = status === "thinking" ? 1 : 0;
        this.start(first, now);
      }
    }
    if (now >= this.due) this.advance(now, charging);
    const fallback = this.image(0);
    let image = this.image(this.current);
    if (!image.complete || !image.naturalWidth) image = fallback;
    if (image.complete && image.naturalWidth) ctx.drawImage(image, x, y, width, width * 208 / 192);
  }
  advance(now, charging) {
    const mapping = data.stateMap[this.status] || data.stateMap.idle;
    if (!this.action) {
      if (this.status === "approval") return;
      if (["thinking", "working", "testing"].includes(this.status)) {
        this.start(mapping[this.alternate++ % mapping.length], now);
      } else {
        let chosen;
        if (charging && now >= this.nextWash) {
          this.nextWash = now + randomWait(data.specialMs);
          if (Math.random() < data.washChance) chosen = "wash-face";
        }
        this.start(chosen || choose(data.micro), now);
      }
    }
    let clip = data.actions[this.action];
    if (this.step === clip.frames.length) {
      if (++this.repeated < clip.repeat) this.step = 0;
      else if (clip.outro) this.start(clip.outro, now);
      else if (clip.loop && this.status === "testing") this.start(mapping[++this.alternate % mapping.length], now);
      else { this.rest(now, charging); return; }
      clip = data.actions[this.action];
    }
    this.current = clip.frames[this.step];
    if (now - this.due > 100) this.due = now;
    this.due += Math.max(charging ? 0 : 180, clip.ms[this.step++]);
    if (this.step < clip.frames.length) this.image(clip.frames[this.step]);
  }
}
