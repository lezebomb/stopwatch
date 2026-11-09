// Only the pinned Muse SDK's encrypted, MITM-protected phone-setup service.
export const SERVICE = "4d757365-0001-4000-8000-6a6f6c6c7900";
const COMMAND = "4d757365-0002-4000-8000-6a6f6c6c7900";
const STATUS = "4d757365-0003-4000-8000-6a6f6c6c7900";
const encoder = new TextEncoder();

export function validateNetwork(ssid, password, open = false) {
  if (/[\r\n\0]/.test(ssid + password) || !ssid || encoder.encode(ssid).length > 32)
    throw new Error("Wi-Fi 名称须为 1–32 字节，不能包含换行。");
  const size = encoder.encode(password).length;
  if (!open && !(size >= 8 && size <= 63) && !/^[a-f\d]{64}$/i.test(password))
    throw new Error("密码须为 8–63 字节，或 64 位十六进制密钥。");
  return { ssid, password: open ? "" : password };
}

export class PhoneSetup {
  constructor(bluetooth, onDisconnect = () => {}) {
    this.bluetooth = bluetooth;
    this.onDisconnect = onDisconnect;
    this.queue = Promise.resolve();
    this.generation = 0;
  }
  get connected() { return !!this.device?.gatt.connected && !!this.command; }
  async connect() {
    this.disconnect();
    const device = await this.bluetooth.requestDevice({
      filters: ["MuseGadget-", "Muse-", "HomeLink-"].map(namePrefix => ({ namePrefix })),
      optionalServices: [SERVICE],
    });
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      if (this.device !== device) return;
      this.generation++;
      this.command = this.statusCharacteristic = null;
      this.onDisconnect();
    });
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      this.command = await service.getCharacteristic(COMMAND);
      this.statusCharacteristic = await service.getCharacteristic(STATUS);
      // The protected read asks Android to pair using the code on the gadget.
      return await this.status();
    } catch (error) { this.disconnect(); throw error; }
  }
  disconnect() {
    this.generation++;
    const device = this.device;
    this.device = null;
    this.command = this.statusCharacteristic = null;
    device?.gatt.disconnect();
  }
  exclusive(action) {
    const device = this.device;
    const generation = this.generation;
    const job = this.queue.then(() => {
      this.ensureConnection(generation);
      if (this.device !== device) throw new Error("蓝牙连接已改变，请重试。");
      return action(generation);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  ensureConnection(generation) {
    if (!this.connected || generation !== this.generation) throw new Error("蓝牙连接已断开，请重新连接。");
  }
  async readStatus(generation) {
    this.ensureConnection(generation);
    const value = await this.statusCharacteristic.readValue();
    this.ensureConnection(generation);
    const status = JSON.parse(new TextDecoder().decode(value));
    if (!status.wifi || typeof status.wifi.state !== "string")
      throw new Error("设备状态不完整，请重新连接。");
    return status;
  }
  status() { return this.exclusive(generation => this.readStatus(generation)); }
  commandStatus(key, value = "") {
    return this.exclusive(async generation => {
      await this.command.writeValueWithResponse(encoder.encode(`${key}=${value}`));
      const status = await this.readStatus(generation);
      const prefix = `${key}: `;
      if (!status.last?.startsWith(prefix)) throw new Error("挂件未确认命令。");
      return status.last.slice(prefix.length);
    });
  }
  async enroll(code) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(code) || (await this.commandStatus("sync.enroll", code)) !== "ok")
      throw new Error("挂件未接受授权。请确认已联网、已打开手机配网，并使用支持无线同步的固件。");
  }
  enrollmentStatus() { return this.commandStatus("sync.status"); }
  provision(ssid, password, open = false) {
    const network = validateNetwork(ssid, password, open);
    return this.exclusive(async generation => {
      let status;
      try {
        for (const [key, value] of [["wifi.ssid", network.ssid], ["wifi.pass", network.password], ["wifi.connect", ""]]) {
          this.ensureConnection(generation);
          await this.command.writeValueWithResponse(encoder.encode(`${key}=${value}`));
          status = await this.readStatus(generation);
          if (status.last !== `${key}: ok`)
            throw new Error("设备未确认配置，请重试；不会继续发送后续命令。");
        }
      } finally { network.password = ""; }
      return status;
    });
  }
}
