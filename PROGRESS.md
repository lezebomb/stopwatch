# StopWatch 0.2.0 进度

记录日期：2026-11-09，北京时间。软件模型、真实编译、实机验证分别记录。

## 本轮完成

- 沿用Muse SDK固定commit和ESP-IDF v6.0.3，不改分区布局、不重写驱动/Bootloader。
- 固件增加HTTPS更新、RSA-PSS签名清单、严格大小/SHA256、官方镜像验签、版本匹配、备用槽切换、启动健康确认/回滚、失败版本隔离和退避。
- 充电/联网/空闲/电量/通话策略，手动检查和版本状态页面。电池照片页不为更新联网；已保存设置不再被启动默认值重置。
- 默认flash_args去除photos.bin。程序更新不碰个人照片、配置与授权。系统资源单独清单、写时复制和指针恢复，空间不足拒绝。
- main自动测试/构建、成功后GitHub Pages；正式Release再验证，缺生产身份失败关闭。Windows与生产控制台打包流程已加入。
- 静态演示无需仓库/Node，支持子路径及移动端，不请求任何API/WS；网页JS/CSS内容哈希与前台版本检查自动刷新。
- Windows图形首次安装/设置、含Node运行时的包、用户级后台启动、DPAPI、签名更新、独立版本及恢复实现。仅执行PlanOnly，没有安装。
- 真实App Server引擎接入点、自己创建会话恢复、工作区allowlist、按次审批、真实在线状态和授权失效停止重试；只用替身测试，没有访问真实账号。
- production中转的固定TLS Origin、安全cookie、目的隔离的一次性电脑授权、滚动续期、撤销及执行默认关闭。

## 实际验证

| 项目 | 结果 |
|---|---|
| npm test | 20通过、0失败、0跳过；包括实际C编译执行、HTTPS/验签/篡改/断线、模拟双槽回滚、数据保留、资源事务、Windows暂存损坏、生产授权和App Server替身 |
| Web构建 | 本地与隔离静态构建均通过 |
| Edge E2E | 本地桌面/移动控制台通过；静态/stopwatch/子路径直接打开、任务/图片、零API/WS请求通过 |
| Windows包 | 实际打包Node24与ESM桥接/监督器；Node语法检查通过，PowerShell5.1 PlanOnly通过，Executed=false |
| ESP-IDF固件 | 0.2.0已真实编译；包含完整更新路径；当前应用约2.82MiB（0x2d1000），4MiB槽剩余30%；最终报告以build-security.json和日志为准 |
| SDK配置 | rollback和软件签名开启；硬件Secure Boot/eFuse anti-rollback/Flash及NVS密钥生成关闭；默认flash_args无photos.bin |
| GitHub Actions / Pages | 已启用Pages workflow发布；本轮远端运行结果在提交后补充 |
| 真实USB/刷写/电流/断电 | 未执行，设备未连接 |

日志在忽略目录.tools，二进制artifacts/stopwatch.bin，完整构建firmware/build。正式发布需要生产公钥和私钥secret；当前没有正式Release、真实域名或VPS部署。

## 仍需完成/验证

1. 正式公钥与secret、固定生产域名和经授权的中转部署；不能用开发身份冒充可交付生产系统。
2. 实机启动、签名OTA、异常重启回滚、断电前中后恢复、存储/触屏/按键/音频/电池、真实续航。
3. Muse真实账号/SDK授权和长期刷新，Codex收礼人账号下的真实会话恢复；当前没有读取Token或登录。
4. 设备私人相册/系统资源的无线传输仍未接线；资源事务和断点故障目前在电脑端测试，不能声称已经自动传到挂件。
5. Windows GUI交互、实际登录自启动/停止/卸载、脚本发布策略、断网及账号过期恢复需交付环境验证；当前仅打包/计划/替身测试。
6. 桥接应用bundle可自动更新；bootstrap/Node运行时大版本需单独迁移发布。不兼容版本拒绝盲装。
7. 后台Web Push仍未启用，华为Edge/Chrome后台通知不作稳定保证；打开时事件同步。

下一次接USB先识别和完整备份，再确认首次生产初始化；以后用OTA，不重写照片镜像。详见HARDWARE_TEST.md和docs/DELIVERY.md。
