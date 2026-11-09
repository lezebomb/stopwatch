# 架构与边界（0.2.0）

## 产品链路

固定 HTTPS 手机控制台 / StopWatch → 独立域名 TLS 反代 → loopback relay / SQLite ← 当前用户 Windows 主动 WSS ← 独立 Codex App Server stdio。生产默认禁止执行，首次安装选工作区并明确授权后才能开启。没有登录或部署真实 VPS。

公开 GitHub Pages 为独立静态演示：浏览器 Mock、内存图片、零 API / WS 请求。开发者本地 CMD 入口保留；演示身份不能用于生产。

- server/app.mjs、store.mjs：profile / 固定 Origin、受保护 cookie、浏览器与电脑目的隔离的短时授权、撤销、持久事件与幂等。
- bridge/client.mjs：主动连接、退避、SQLite outbox / 处理日志；崩溃时不重放不确定的执行命令。
- bridge/real-engine.mjs、app-server.mjs：真实 stdio 适配、工作区 allowlist、仅恢复自身线程、按请求审批 / TTL、授权失效停止重试。当前用替身验证，未连接真实账号；不接管 Desktop 会话。
- windows/：一次图形安装，自带 Node，DPAPI、用户级自动启动；监督器与可更新应用分离，签名暂存、健康确认、回退、停止 / 撤销 / 卸载。没有在开发电脑安装。
- web/：事件控制台、466px 模拟器、哈希静态资源与前台自动版本刷新；生产额度来自真实提供者，不能伪造百分比。

## 设备与更新

Muse 固定 commit、ESP-IDF v6.0.3 和现有驱动保持，prepare 从锁定 blob 生成可复现补丁。CO5300 / CST820 / M5PM1 / M5IOE1 / ES8311、音频队列与官方 Muse 授权链路继续沿用。黄键 GPIO2 TALK、蓝键 GPIO1 SPEAKER；没有旁路录音管线。

sw_update_core 为便携 C 策略 / 写入顺序；sw_updater 为真实 ESP 适配。RSA-PSS 签名清单 → HTTPS CA / 主机名验证 → 备用槽流式写入及完整 SHA256 → 官方 esp_ota_end 镜像验签 → 版本匹配 → 持久待确认记录 → 官方切槽 → UI / 照片 / 存储 / 服务健康检查。Bootloader rollback 保留，健康失败回退，不依赖外网连接才能确认健康。

默认每6小时，联网恢复30分钟限频，稳定60秒、空闲30秒、电量40%以上且充电、无通话 / 交互才安装；失败有界指数退避。更新器不会主动为检查唤醒电池模式 Wi-Fi。阈值保存于独立 sw_updates NVS 命名空间，设置页可手动检查。

保持 table=0x10000、两个4MiB OTA槽、product分区和0x822000的7MiB photos。程序更新不改分区 / Bootloader，不触碰私人数据，不烧eFuse。默认不向 flash_args 加 photos.bin；只有首次初始化显式 FactoryAssets。

## 数据与资源

固件程序、system动态资源、私人照片 / 配置 / 账号分开。ResourceStore 有签名清单、逐文件 SHA256、临时写入、不可变对象、active / previous 原子切换与恢复；写时复制空间不足就拒绝。不能在7MiB中承诺同时存两套6MiB相册。

实际设备无线照片 / 资源传输仍未接线；资源事务目前在电脑端执行。固件仍使用构建的默认照片资源，不能把手机上传演示当成照片已到实物。真实授权刷新、设备电流、实际回滚 / 断电恢复均待实机验收。

## 发布与部署

main 经 CI 后部署 Pages；正式 Release 经验证及 production-signing 环境产生签名固件 / 清单、Windows 包和生产控制台制品。生产公钥 / secret / 域名缺失时失败关闭。无 SSH 自动执行步骤；未来独立版本目录、健康后切换、保留持久 data，不能改动 VPS 已有代理。详见 DELIVERY.md、SECURITY.md 和 HARDWARE_TEST.md。
