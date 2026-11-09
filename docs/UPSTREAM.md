# 官方资料核对（2026-11-09）

| 来源 | 采用内容 |
|---|---|
| [M5Stack StopWatch C152](https://docs.m5stack.com/en/core/StopWatch) | 硬件型号、显示屏、Flash/PSRAM、电池；以设备版本及原理图复核 |
| [Muse SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/463bd2a05380fea4211b0099ad0f70933c108b20/esp32) | 固定 `463bd2a05380fea4211b0099ad0f70933c108b20`，Apache-2.0 |
| [Muse ESP32 AGENTS](https://github.com/facebookincubator/muse-gadget-sdk/blob/463bd2a05380fea4211b0099ad0f70933c108b20/esp32/AGENTS.md) | 明确仅支持 ESP-IDF v6.0.3；StopWatch 已有完整板级支持 |
| [StopWatch board](https://github.com/facebookincubator/muse-gadget-sdk/blob/463bd2a05380fea4211b0099ad0f70933c108b20/esp32/components/muse/boards/board_m5stack_stopwatch.c) | QSPI 引脚、I²C、电源、按键与音频均沿用该驱动 |
| [ESP-IDF v6.0.3](https://github.com/espressif/esp-idf/tree/v6.0.3) | commit `76f5dedd9950a3012fee8fb7d5586df21fc67802` |
| [PowerDemo](https://github.com/m5stack/M5StopWatch-PowerDemo/tree/a68d0302324f2b289a790d29fa8a3690abc21011) | 只作电源资料参考；其 SDK 为 5.5.5，不混用到 Muse 工程 |
| [OpenAI App Server](https://learn.chatgpt.com/docs/app-server) | stdio 初始化、线程/轮次、审批、事件与额度；配合本机生成 schema 核对 |

## 硬件驱动查证要点

466×466 CO5300 QSPI：CS39 / CLK40 / D0=41 / D1=42 / D2=46 / D3=45，显示 x gap=6。共用 I²C SDA47 / SCL48；CST820=0x15，M5PM1=0x6E，M5IOE1=0x4F；黄键 GPIO2、蓝键 GPIO1。红色电源键由 PMIC 控制，绝不能凭空指定 ESP GPIO。ES8311 的 I²S MCLK18 / BCLK17 / WS15 / DOUT21 / DIN16。以上是固定上游源码的配置，尚未在本台实物上验证。

## Codex 核对

`npm run protocol:check` 调用当前 PATH 的 `codex app-server generate-json-schema`，验证 `initialize`、`thread/list`、`thread/read`、`thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`、`account/rateLimits/read` 确实存在。`turn/steer` 要求 `expectedTurnId`。审批是服务端发来的带 ID 请求，响应使用同一 ID；不是猜测的“approve”RPC。

本机沙箱中的 Desktop 捆绑 CLI 报告 0.167.0-alpha.3.2；原生执行环境 PATH 的 CLI 报告 0.164.0。schema 检查产物记录实际二进制版本。二者不能混称为同一次运行。没有执行账户 RPC、读取 Token 或接管当前会话。额度仅在接口确实返回对应窗口时展示；当前界面中的 5 小时/周额度明确为模拟。

## 更新与许可

Windows 的 GCC 15 构建还需要一处局部上游兼容补丁：`muse_chat_session.cpp` 的连接错误提示把 hostname 格式限定为 `%.32s`，以适配调用处 48 字节缓冲区，保留 `-Werror`。照片扩展显式包含 LVGL 9.5 的图片缓存头文件。补丁由 prepare 脚本从锁定 blob 生成，不直接修改音频或网络状态机。

项目新增代码为 Apache-2.0。第三方 Muse / ESP-IDF 的源文件、版权头、LICENSE、NOTICE、子组件许可证应随固件分发保留；中文字体 Noto Sans SC 的 OFL 要求保留。`THIRD_PARTY_NOTICES.md` 记录入口。不要提交上游的开发签名密钥到本仓库；固件构建沿用上游开发签名但不启用 Secure Boot 或烧写 eFuse。正式礼物固件需要独立签名与安全存储评审，开发签名不提供生产防篡改保证。

## 0.2.0 OTA核对补充

已核对ESP-IDF v6.0.3官方OTA API、软件签名和回滚Kconfig。本轮真实构建及espsecure验签通过，默认photos镜像不进入flash_args。上游原先依赖Link联网的健康任务仅对StopWatch交由本项目的离线健康检查替代。开发构建仍用上游公开开发镜像签名；生产构建必须匹配独立RSA3072公钥和环境secret，缺失即拒绝。

[官方OTA与回滚](https://docs.espressif.com/projects/esp-idf/en/v6.0.3/esp32s3/api-reference/system/ota.html)、[无需硬件Secure Boot的软件签名](https://docs.espressif.com/projects/esp-idf/en/v6.0.3/esp32s3/security/secure-boot-v2.html)。不开硬件Secure Boot / anti-rollback / Flash或NVS加密，不烧eFuse。生产显示真实额度或未知值；Mock额度不等于账号信息。

## 实机核对补充

本轮真实设备原厂应用StopWatch-UserDemo cf51acc使用IDF5.5.4；本项目实际启动IDF6.0.3。官方SDK的USB console hook、MP3 selftest和声学回环均复用；不重写音频/电源驱动。已有本机Codex 0.164.0登录用于一次真实App Server任务及额度接口初始化，设备接收真实事件；此前仅schema/替身的说明属于旧阶段。私人数据仅存.data。
