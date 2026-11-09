# StopWatch · 随身的小小陪伴

为 M5Stack StopWatch C152 开发的私人礼物项目：离线照片封面、官方 Muse、Codex 桌宠与移动网页控制台。当前为可本地运行的 **Mock MVP**；没有连接硬件、登录真实 Muse/Codex 账号或部署 VPS。

![控制台预览](assets/preview-desktop.png)

## 在这台 Windows 电脑上预览

在 `D:\stopwatch` 双击 **Start-StopWatch.cmd**，会构建网页、启动本地中转和 Mock 桥接，并用 Edge 打开短时配对链接。保持启动窗口运行；Ctrl+C 停止。Node.js 24 是运行前提。

也可以执行：

```powershell
cd D:\stopwatch
npm.cmd ci
npm.cmd run build
npm.cmd start
```

打开启动输出中的 `http://127.0.0.1:8787/#pair=...`（两分钟、一次性）。控制台和模拟器共用同一个 Web App，模拟器位于总览；`http://127.0.0.1:8787/simulator` 也可以打开。过期后运行 `node scripts/pair.mjs` 获取新链接，或在已配对控制台设置中生成二维码。

所有服务只绑定 `127.0.0.1`。**手机不能访问电脑的 127.0.0.1**；当前可用 Edge 的移动视口预览，实际 Mate 80 Pro Max 联机与 HTTPS 中转属于下一阶段。未开局域网端口，未改代理，不需要 APK。

## 可以体验什么

- 466×466 圆屏模拟器：点击换照片、左右滑动切页、黄键按住/松开模拟说话、蓝键模拟静音、猫咪桌宠、五次轻点彩蛋、日期彩蛋、充电/电量/Wi-Fi 控件。
- 照片管理：上传、实际解码、居中裁切、JPEG 预览与设备 RGB565 转换、默认封面、删除、6MiB/12张容量限制。三张内置风景为程序原创测试图。
- Mock Codex：项目/任务、执行过程、继续、追加、中断、按次批准或拒绝、结果、模拟额度、实时事件与未读提示。输入“审批”触发确认，输入“失败”触发失败。
- 设置与中文指南：亮度、轮播、边框、彩蛋留言与日期、一次性二维码、只读权限、撤销浏览器授权。
- 本地中转 + 主动连接的 Windows Mock 桥接：SQLite 持久化、命令幂等、事件去重/重放、离线排队和自动重连。
- ESP-IDF 固件扩展：基于官方 Muse StopWatch 驱动，加入照片、界面切换、中文指南、Codex Mock 表情、彩蛋、NVS 和电源策略。真实 Muse 配对/语音管线保持上游实现；黄键固定录音。

手机上传的照片目前保存于电脑，**设备网络同步尚未接线**。固件使用构建时的三张测试图；真实 Codex stdio 适配器尚未接入运行链路，Desktop 会话不接管。后台 Web Push、动态图片解码/视频封面与设备在线遥测尚未实现。

## 固件环境与构建

官方 Muse 固定 commit、ESP-IDF **v6.0.3** 和组件锁见 `upstream.lock.json` / `firmware/dependencies.lock`。PowerDemo 使用 5.5.5，仅作参考，不能替代 Muse 的 SDK 版本。

本机工具均已放在项目 `.tools` / `.deps` 下。没有安装 WSL 或进行管理员系统配置。新电脑先安装 Git、Node.js 24 和便携式 [uv](https://docs.astral.sh/uv/)，再运行：

```powershell
./scripts/setup.ps1
./scripts/build-firmware.ps1
# 实验性实时语音为另一构建目录；需要后续实机验证：
./scripts/build-firmware.ps1 -Realtime
```

常规固件在 `firmware/build/`，成功时应用复制为 `artifacts/stopwatch.bin`。不要只拿应用 bin 猜偏移刷写：分区表、bootloader、SPIFFS 与 flash_args 必须对应同一次构建。脚本只构建，**绝不刷写**。完整刷写/备份说明见 [HARDWARE_TEST.md](HARDWARE_TEST.md)。

工具下载如遇 GitHub 504，可使用脚本配置的乐鑫官方镜像；不关闭证书验证。初次下载工具和组件需较长时间及数 GB 磁盘空间。上游不带 SDK Token 可构建离线界面，但不能声称完成真实 Muse 授权。

## 测试

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
npm.cmd run protocol:check
npm.cmd audit
```

主机 C 测试使用 `.tools/host/ziglang/zig.exe`（setup 脚本安装）。浏览器测试启动独立 headless Edge 上下文、独立临时数据库，不使用现有浏览器账号；默认 Edge 在 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`，可用 `EDGE_BIN` 指定路径。测试截图输出到 `artifacts/desktop.png` / `mobile.png`。`protocol:check` 只生成并检查本机 CLI 的 schema，不访问账号。

Web、API、Mock 与 C 主机测试结果不等于 ESP32 硬件测试或实测续航。最新实际记录见 [PROGRESS.md](PROGRESS.md)。

## 目录

```text
firmware/       固件扩展、分区表、Kconfig overlay、组件锁
server/         本地 HTTP / WS / SQLite 中转
bridge/         Windows 主动连接、Mock、未接线的真实 RPC 适配器
web/            移动控制台与交互模拟器
shared/         状态定义、照片预算、中文指南
scripts/        安装、构建、配对与启动工具
tests/          C 主机、API/通信/异常、Edge 浏览器测试
assets/         自制测试风景图
docs/           架构、协议、上游考证
deploy/         尚不可直接上线的 Caddy 设计示例
.data/          私密运行数据（Git 忽略）
.tools/ .deps/  本项目专用工具与上游源码（Git 忽略）
```

## 安全与交付

不要提交 `.data`、真实 Token、照片、密码、代理订阅或生成的 sdkconfig。当前公开仓库只包含测试资源。正式远程控制需收礼人授权、设备身份与安全下发、生产 TLS/Origin/ACL 配置、独立签名和实机测试。见 [SECURITY.md](SECURITY.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/UPSTREAM.md](docs/UPSTREAM.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
