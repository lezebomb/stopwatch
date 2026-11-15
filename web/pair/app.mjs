import { PhoneSetup } from "../setup/transport.mjs";
const $ = id => document.getElementById(id);
const expected = new URLSearchParams(location.search).get("device") || "";
const settingsView = new URLSearchParams(location.search).get("view") === "settings";
let challenge = "", deviceRef = "", busy = false, expires = 0;
const say = text => { $("message").textContent = text; };
const client = new PhoneSetup(navigator.bluetooth, () => {
  $("code").value = ""; $("verify").hidden = true;
  $("start").disabled = false;
  say("蓝牙已断开。原有 Wi-Fi、Muse 和控制台授权都保留；需要时重新打开挂件的手机配对。");
});
async function request(route, data) {
  const response = await fetch(`/api/phone/${route}`, data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "配对暂时不可用");
  return result;
}
function enter(ref) { location.replace(`/?device=${encodeURIComponent(ref || expected)}${settingsView ? "&view=settings" : ""}`); }
$("start").onclick = async () => {
  if (busy) return;
  busy = true; $("start").disabled = true;
  try {
    say("请选择这台挂件，按系统提示完成蓝牙安全连接。");
    const status = await client.connect();
    deviceRef = await client.commandStatus("phone.ref");
    if (!/^[a-f0-9]{64}$/.test(deviceRef)) throw new Error("挂件尚未准备好手机授权，请联系所有者；无需清除 Muse 或 Wi-Fi。");
    if (expected && expected !== deviceRef) throw new Error("选择了另一台挂件，请选择二维码对应的设备。");
    $("device").textContent = `${status.name} · ${status.wifi.state === "connected" ? "设备已联网" : "等待联网（不影响本次配对）"}`;
    const created = await request("challenge", { deviceRef });
    challenge = created.challenge; expires = created.expires;
    const result = await client.commandStatus("phone.begin", challenge);
    if (result !== "ok") throw new Error("挂件未开启本次配对，或上次验证码尚未到期。请从挂件手机配对页重新开始。");
    $("verify").hidden = false; $("code").focus();
    say("请输入挂件上刚显示的六位验证码，两分钟内有效。配对成功会直接进入控制台。");
  } catch (error) { say(error.message); $("start").disabled = false; }
  finally { busy = false; }
};
$("verify").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const code = $("code").value.trim();
  $("code").value = "";
  if (!/^\d{6}$/.test(code)) return say("请输入六位数字。");
  if (Date.now() >= expires) return say("验证码已过期，请在挂件重新打开手机配对。");
  busy = true; $("submit").disabled = true;
  try {
    const proof = await client.commandStatus("phone.prove", code);
    if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error(proof === "wrong-code" ? "验证码不正确，请查看挂件；最多尝试五次。" : "验证码已失效或尝试过多，请在挂件重新打开配对。");
    const paired = await request("complete", { challenge, code, proof });
    say(paired.role === "manager" ? "配对成功，正在进入照片与设备管理。" : "配对成功，正在进入只读控制台；管理权限由现有管理手机授予。");
    enter(paired.deviceRef);
  } catch (error) { say(error.message); }
  finally { busy = false; $("submit").disabled = false; }
};
try {
  const status = await request(`session${expected ? `?device=${encodeURIComponent(expected)}` : ""}`);
  if (status.paired) enter(status.deviceRef);
  else if (!isSecureContext || !navigator.bluetooth) say("请在华为/Android Chrome 或支持网页蓝牙的 Edge 中打开。无需安装 APK。");
  else { say("请保持挂件的手机配对页打开。Wi-Fi 设置与本次手机授权相互独立。"); $("start").disabled = false; }
} catch { say("暂时无法连接服务，请检查手机网络后刷新；不会清除已有配对。"); }
addEventListener("pagehide", () => { $("code").value = ""; challenge = ""; client.disconnect(); });
