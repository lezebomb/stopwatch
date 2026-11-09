import { test } from "node:test";
import assert from "node:assert/strict";
import { PhoneSetup, SERVICE, validateNetwork } from "../web/setup/transport.mjs";

function fakePhone({ failWrite = -1, failAck = -1, rejectPairing = false, onWrite = () => {} } = {}) {
  const writes = [], events = [];
  let last = "ready", count = 0;
  const status = { async readValue() {
    if (rejectPairing) throw new Error("authentication required");
    return new TextEncoder().encode(JSON.stringify({ wifi: { state: "connecting" }, last }));
  } };
  const command = { async writeValueWithResponse(bytes) {
    const index = count++;
    if (index === failWrite) throw new Error("link dropped");
    const line = new TextDecoder().decode(bytes);
    writes.push(line);
    onWrite(index);
    last = `${line.split("=")[0]}: ${index === failAck ? "error" : "ok"}`;
  } };
  const device = {
    addEventListener() {},
    gatt: {
      connected: false,
      async connect() { this.connected = true; return { async getPrimaryService(id) {
        assert.equal(id, SERVICE);
        return { async getCharacteristic(id) { return id.includes("0002") ? command : status; } };
      } }; },
      disconnect() { this.connected = false; },
    },
  };
  const bluetooth = { async requestDevice(options) { events.push(options); return device; } };
  return { client: new PhoneSetup(bluetooth), writes, events };
}

test("phone provisioning preserves exact SSID/password and supports saved hotspot credentials", async () => {
  const { client, writes, events } = fakePhone();
  await client.connect();
  await client.provision("热点 = home ", "space=pass ");
  assert.deepEqual(writes, ["wifi.ssid=热点 = home ", "wifi.pass=space=pass ", "wifi.connect="]);
  assert.deepEqual(events[0].optionalServices, [SERVICE]);
  assert.equal("acceptAllDevices" in events[0], false);
});
test("unpaired phone cannot send credentials", async () => {
  const { client, writes } = fakePhone({ rejectPairing: true });
  await assert.rejects(client.connect());
  await assert.rejects(client.provision("home", "password"));
  assert.deepEqual(writes, []);
});
test("write failure or device error never sends wifi.connect with stale credentials", async () => {
  for (const options of [{ failWrite: 0 }, { failWrite: 1 }, { failAck: 0 }, { failAck: 1 }]) {
    const { client, writes } = fakePhone(options);
    await client.connect();
    await assert.rejects(client.provision("home", "password"));
    assert.ok(writes.every(value => !value.startsWith("wifi.connect")));
  }
});
test("only explicit open-network choice sends an empty password; validates byte lengths and injection", async () => {
  assert.throws(() => validateNetwork("中".repeat(11), "password"));
  assert.throws(() => validateNetwork("home\nwifi.forget", "password"));
  assert.throws(() => validateNetwork("home", "password\0"));
  assert.throws(() => validateNetwork("home", ""));
  assert.throws(() => validateNetwork("home", "g".repeat(64)));
  assert.doesNotThrow(() => validateNetwork("home", "f".repeat(64)));
  const { client, writes } = fakePhone();
  await client.connect();
  await client.provision("home", "", true);
  assert.equal(writes[1], "wifi.pass=");
});
test("disconnect during a credential transaction cancels remaining commands", async () => {
  let client;
  const fake = fakePhone({ onWrite: () => client.disconnect() });
  client = fake.client;
  await client.connect();
  await assert.rejects(client.provision("home", "password"));
  assert.deepEqual(fake.writes, ["wifi.ssid=home"]);
});
