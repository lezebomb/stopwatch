import { PhoneSetup, validateNetwork } from "./transport.mjs";
const $ = id => document.getElementById(id);
let busy = false, target = "", submitted = false, completed = false;
let confirmAfter = 0;
let ticket = /^#device=([A-Za-z0-9_-]{32})$/.exec(location.hash)?.[1] || "";
const enrollment = !!ticket;
let enrollmentDeadline = 0;
if (enrollment) {
  history.replaceState(null, "", location.pathname);
  $("enrollment").hidden = false;
  $("form").hidden = true;
  $("setup-step").textContent = "点击「授权这台挂件」，等待挂件通过 Wi-Fi 确认。";
}
const say = text => { $("message").textContent = text; };
const client = new PhoneSetup(navigator.bluetooth, () => {
  $("password").value = "";
  $("network").disabled = true;
  $("connect").disabled = false;
  $("disconnect").disabled = true;
  $("enroll").disabled = true;
  if (!completed)
    say("蓝牙已断开。可在挂件上查看联网结果，需要修改时重新打开手机配网。");
});
function render(status) {
  $("device").textContent = `${status.name} · 固件 ${status.fw}`;
  const state = status.wifi.state;
  const names = { off: "Wi-Fi 已关闭", no_network: "尚未配置网络", connecting: "正在连接 Wi-Fi…", connected: "Wi-Fi 已连接", failed: "连接失败，请检查密码与网络设置", not_nearby: "暂未找到已保存网络，请确认热点开启且使用 2.4GHz" };
  $("wifi-status").textContent = names[state] || "等待设备状态";
  if (enrollment) {
    $("enroll").disabled = !ticket || state !== "connected";
    say(state === "connected" ? "已连接挂件，可以授权无线同步。" : "请先让挂件连上 Wi-Fi，再从手机控制台重新打开授权链接。");
    return;
  }
  const matched = state === "connected" && (!target || status.wifi.ssid === target);
  if (matched && Date.now() >= confirmAfter) {
    completed = submitted;
    say(submitted
      ? `已连接 ${status.wifi.ssid}。挂件会记住网络，可以关闭此页。`
      : `当前已连接 ${status.wifi.ssid}。你也可以添加其他网络。`);
  } else if (submitted) {
    completed = false;
    say(state === "connected" && !matched
      ? "挂件目前连着另一个已保存网络。测试热点时请离开原网络覆盖范围，并保持热点开启。"
      : "挂件已收到配置。手机热点请保持开启，密码错误可修改后重新提交。");
  }
}
$("connect").onclick = async () => {
  if (busy) return;
  target = "";
  confirmAfter = 0;
  submitted = completed = false;
  busy = true; $("connect").disabled = true;
  say("选择你的 MuseGadget 设备。手机要求配对时，输入挂件屏幕显示的六位码。");
  try {
    render(await client.connect());
    $("network").disabled = false; $("disconnect").disabled = false;
    if (!enrollment && !$("wifi-status").textContent.includes("已连接")) say("蓝牙安全连接已建立，可以在下面输入 Wi-Fi 或手机热点。");
  } catch {
    say("未能完成连接。请打开手机蓝牙及浏览器的附近设备权限，确认挂件处于手机配网页，重试并输入屏幕配对码。没有完成配对不会发送密码。");
    $("connect").disabled = false;
  } finally { busy = false; }
};
$("disconnect").onclick = () => {
  client.disconnect(); $("network").disabled = true; $("connect").disabled = false;
  $("enroll").disabled = true;
  $("disconnect").disabled = true; say("已断开蓝牙，设备保存的网络和授权保持不变。");
};
$("enroll").onclick = async () => {
  if (busy || !ticket) return;
  busy = true;
  $("enroll").disabled = true;
  try {
    await client.enroll(ticket);
    ticket = "";
    enrollmentDeadline = Date.now() + 30000;
    say("挂件正在确认授权，请保持 Wi-Fi 和蓝牙连接。");
  } catch (error) {
    say(error.message);
    $("enroll").disabled = !client.connected;
  } finally { busy = false; }
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
  completed = false;
  say("正在通过加密蓝牙保存到挂件…");
  try {
    const status = await client.provision(network.ssid, network.password, $("open-network").checked);
    target = network.ssid;
    submitted = true;
    // The previous connection can still be up while the keeper applies new credentials.
    confirmAfter = Date.now() + 1000;
    render(status);
  } catch { say("配置未完整确认，请重新连接后重试。不会自动重复发送密码。"); }
  finally { network.password = ""; busy = false; $("save").disabled = false; }
};
setInterval(async () => {
  if (!client.connected || busy || document.hidden) return;
  busy = true;
  try {
    if (enrollmentDeadline) {
      const state = await client.enrollmentStatus();
      if (state === "paired") {
        completed = true;
        enrollmentDeadline = 0;
        say("挂件已获授权，会自动同步照片和任务状态。可以关闭此页。");
      } else if (state !== "pending" || Date.now() >= enrollmentDeadline) {
        enrollmentDeadline = 0;
        say("挂件未确认授权。请检查网络并在手机控制台生成新的授权链接。");
      }
    } else if (!enrollment || ticket) {
      render(await client.status());
    }
  }
  catch { say("暂时读不到设备状态，请检查蓝牙连接，必要时重新连接。"); }
  finally { busy = false; }
}, 3000);
addEventListener("pagehide", () => { ticket = ""; $("password").value = ""; client.disconnect(); });
if (!isSecureContext || !navigator.bluetooth) {
  $("connect").disabled = true;
  say("请用 Android Chrome 或支持网页蓝牙的 Edge 打开。如果手机无法使用网页蓝牙，可在挂件的「设置 → Wi-Fi」直接联网。");
}
