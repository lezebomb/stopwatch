import { PhoneSetup, validateNetwork } from "./transport.mjs";
const $ = id => document.getElementById(id);
let busy = false, target = "", submitted = false;
const say = text => { $("message").textContent = text; };
const client = new PhoneSetup(navigator.bluetooth, () => {
  $("network").disabled = true;
  $("connect").disabled = false;
  $("disconnect").disabled = true;
  say("蓝牙已断开。已保存的 Wi-Fi 不受影响；需要修改时重新连接。");
});
function render(status) {
  $("device").textContent = `${status.name} · 固件 ${status.fw}`;
  const state = status.wifi.state;
  const names = { off: "Wi-Fi 已关闭", no_network: "尚未配置网络", connecting: "正在连接 Wi-Fi…", connected: "Wi-Fi 已连接", failed: "连接失败，请检查密码与网络设置", not_nearby: "暂未找到已保存网络，请确认热点开启且使用 2.4GHz" };
  $("wifi-status").textContent = names[state] || "等待设备状态";
  if (state === "connected" && (!target || status.wifi.ssid === target)) {
    say(`已连接 ${status.wifi.ssid}。设备会记住网络，可关闭此页并返回照片。`);
    submitted = false;
  } else if (submitted) {
    say(state === "connected"
      ? "挂件目前连着另一个已保存网络。测试热点时请离开原网络覆盖范围，并保持热点开启。"
      : "挂件已收到配置。手机热点请保持开启，密码错误可修改后重新提交。");
  }
}
$("connect").onclick = async () => {
  busy = true; $("connect").disabled = true;
  say("选择你的 MuseGadget 设备。手机要求配对时，输入挂件屏幕显示的六位码。");
  try {
    render(await client.connect());
    $("network").disabled = false; $("disconnect").disabled = false;
    if (!$("wifi-status").textContent.includes("已连接")) say("蓝牙安全连接已建立，可以在下面输入 Wi-Fi 或手机热点。");
  } catch {
    say("未能完成连接。请打开手机蓝牙及浏览器的附近设备权限，确认挂件处于手机配网页，重试并输入屏幕配对码。没有完成配对不会发送密码。");
    $("connect").disabled = false;
  } finally { busy = false; }
};
$("disconnect").onclick = () => {
  client.disconnect(); $("network").disabled = true; $("connect").disabled = false;
  $("disconnect").disabled = true; say("已断开蓝牙，设备保存的网络和授权保持不变。");
};
$("open-network").onchange = () => {
  $("password").disabled = $("open-network").checked;
  $("password").required = !$("open-network").checked;
  if ($("open-network").checked) $("password").value = "";
};
$("form").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  let network;
  try { network = validateNetwork($("ssid").value, $("password").value, $("open-network").checked); }
  catch (error) { say(error.message); return; }
  $("password").value = ""; busy = true; $("save").disabled = true;
  say("正在通过加密蓝牙保存到挂件…");
  try {
    const status = await client.provision(network.ssid, network.password, $("open-network").checked);
    target = network.ssid; submitted = true; render(status);
  } catch { say("配置未完整确认，请重新连接后重试。不会自动重复发送密码。"); }
  finally { network.password = ""; busy = false; $("save").disabled = false; }
};
setInterval(async () => {
  if (!client.connected || busy || document.hidden) return;
  busy = true;
  try { render(await client.status()); }
  catch { say("暂时读不到设备状态，请检查蓝牙连接，必要时重新连接。"); }
  finally { busy = false; }
}, 3000);
addEventListener("pagehide", () => { $("password").value = ""; client.disconnect(); });
if (!isSecureContext || !navigator.bluetooth) {
  $("connect").disabled = true;
  say("此浏览器不支持网页蓝牙。请复制当前 HTTPS 地址到 Android Chrome；也可尝试支持网页蓝牙的 Edge。不要在微信内置浏览器中打开。");
}
