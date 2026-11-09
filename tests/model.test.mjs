import { test } from "node:test";
import assert from "node:assert/strict";
import {
  powerPolicy,
  nextScreen,
  validEvent,
  PHOTO_BYTES,
} from "../shared/model.mjs";
test("visible photographs never claim deep sleep; battery networking is opt-in", () => {
  const p = powerPolicy({ charging: false, battery: 70, screen: "photos" });
  assert.equal(p.display, true);
  assert.equal(p.wifi, false);
  assert.equal(p.deepSleep, false);
  assert.equal(p.refreshHz, 1);
  assert.equal(PHOTO_BYTES, 434312);
});
test("critical power, low brightness, charging and unknown battery", () => {
  assert.equal(powerPolicy({ battery: 3 }).display, false);
  assert.equal(powerPolicy({ battery: 12, brightness: 50 }).brightness, 15);
  assert.equal(powerPolicy({ battery: 3, charging: true }).display, true);
  assert.equal(powerPolicy({ battery: -1 }).display, true);
  assert.equal(powerPolicy({ screen: "muse" }).wifi, true);
  assert.equal(powerPolicy({ idleSeconds: 180 }).display, false);
});
test("screen navigation and protocol reject malformed envelopes", () => {
  assert.equal(nextScreen("guide"), "photos");
  assert.equal(nextScreen("photos", -1), "guide");
  assert.equal(validEvent({ v: 1, id: "a", type: "task", payload: {} }), true);
  assert.equal(validEvent({ v: 2, id: "a", type: "task", payload: {} }), false);
  assert.equal(validEvent({ v: 1, id: "a", type: "task", payload: [] }), false);
});
