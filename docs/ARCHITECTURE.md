# 架构与边界

## 当前可运行链路

浏览器控制台 / 466px 模拟器 → 127.0.0.1 Node HTTP + WS 中转 → 主动连接的 Windows Mock 桥接 → MockCodex 状态机。

中转用 Node 24 自带 SQLite（当前 Node 仍提示 experimental），不需要 Go、Docker、外部数据库或管理员权限。选择 Node 是为了复用当前 Windows 已安装工具，降低本轮安装依赖。后续可按协议替换成 Go 中转。没有连接 VPS、代理或真实账号。

- `server/app.mjs`：HTTP、图片转换、认证、WS 角色路由。
- `server/store.mjs`：短时票据、授权、设置、1000 条事件、命令幂等、审计。
- `bridge/client.mjs`：电脑主动连接 relay `/bridge`，不监听家庭公网端口；有界指数退避、持久 outbox、事件确认。
- `bridge/mock.mjs`：Mock 的执行、测试、审批、完成、失败和中断。无任务百分比。
- `bridge/app-server.mjs`：独立 stdio RPC 传输适配器；默认运行不会创建它，也没有真实账号访问测试。
- `shared/model.mjs` / `firmware/companion/sw_model.*`：相同状态顺序、照片限制和电源策略；主机测试分别验证。
- `web/app.mjs`：控制台与圆屏模拟器共用事件流和资源。

## 设备固件

通过锁定的 Muse SDK 扩展，不复制重写硬件驱动。`scripts/prepare-firmware.mjs` 每次从固定 commit 的原始 Git blob 重新生成最小补丁；hook 不匹配即报错。上游下载目录被忽略，补丁源在 `firmware/companion`。驱动继续由 Muse 的 StopWatch board 文件维护：CO5300 QSPI、CST820、M5PM1、M5IOE1、ES8311、音频队列和状态机。

扩展：照片页、页面导航、中文指南、Codex Mock 状态、留言彩蛋、RGB565 资源、NVS 设置、电源策略。黄键 GPIO2 固定 TALK，蓝键 GPIO1 保留 SPEAKER 行为，不新建旁路录音管线。真实 Muse 配对仍在原 UI 内，无 Token 不声称已连接。实验性实时语音用 `-Realtime` 独立构建，未经硬件验证。上游普通界面语言为英文，扩展指南为中文。

Flash 表保持 table=0x10000、双 4 MiB OTA 槽与原 product 分区偏移；增加 7 MiB SPIFFS。照片预算只使用其中 6 MiB，最多 12 张。每张 466²×2=434312 字节 RGB565；12 张约 4.97 MiB，JPEG 预览也计入服务端预算。SPIFFS 失败不自动格式化。

当前上传保存在电脑资源库，**尚未实现设备远程照片同步和安全凭据下发**。固件使用构建时生成的三张原创风景，不表示手机上传已经传到实物。后续应通过具有独立 viewer 设备身份的 HTTPS 拉取清单、流式临时文件写入、校验哈希、原子激活与断电恢复完成同步。不能把浏览器 operator cookie 直接复制给挂件。

## 后续 VPS 链路

StopWatch / 手机 → Caddy HTTPS/WSS → 轻量 relay / SQLite ← Windows 主动 WSS ← 本地独立 Codex App Server stdio。

当前 relay 是严格 loopback 开发配置；Host 与 Origin 校验固定，不可直接改为监听 0.0.0.0 就部署。正式阶段需加入配置化公共 origin、受信反代边界、Secure cookie、浏览器及桥接独立身份、限速/资源配额、设备证书或可轮转密钥、备份和运维检查。`deploy/Caddyfile.example` 仅示意，没有执行部署。

不公开 Codex 原始 RPC。中转只允许白名单命令，不转发任意 shell；真实桥接还需工作区 allowlist、审批到具体 request 的绑定、TTL、每台电脑单一控制权和同一命令持久去重。Desktop 会话同步是独立未实现模块，不能假设独立 App Server 可以接管 Desktop。
