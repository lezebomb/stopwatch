# 2026-11-09 · 已进入实机阶段

- 已同步main，发现并确认真实StopWatch（S3 rev0.2 / 16MiB / 8MiB），完整原厂备份核验成功，私有数据未上传。
- 首次全量安装和后续app-only更新成功；用户已确认照片、触屏、滑动和按键正常。没有整片擦除、eFuse写入或关闭原有安全保护。
- 已打通原照片API→USB→SPIFFS→实际显示缓冲；23.5秒定向实机测试覆盖断传、错误哈希、默认图共存、完整上传、重启保留；后续应用更新再次核对封面不变。
- 已用真实本机Codex App Server完成短任务并推送思考/工作/完成到设备，替换设备Mock点按状态。40秒采样内部空闲堆恒定33567字节；不是长期无泄漏结论。
- SDK离线音频回环8档通过，设置已恢复；人不在场，听感、拔插USB和Wi-Fi配网明确待测。Muse本人授权未完成。
- 修复高电量电池模式仍高亮、临时亮度覆盖偏好、充电被自动休眠和空闲计时相互冲突的问题。只跑5项相关主机测试，均通过；使用增量构建，不反复清理依赖。
- 增加开发期app-only刷写保护，默认不改NVS/照片/分区表；未启用的OTA任务减少常驻栈。后台生产安装和正式更新继续失败关闭，不用开发密钥伪装正式交付。

手机公网真实控制与无线照片同步需要受保护HTTPS入口及配网；当前仍只有隔离Pages演示，未部署VPS。Windows正式登录自启/升级验收、Muse真实会话、OTA断电/回滚、续航和长期运行未完成。详见 HARDWARE_TEST.md。

下方为0.2.0软件阶段历史记录，旧“未接USB”等措辞不代表本轮状态。
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
| npm test | 21通过、0失败、0跳过；包括实际C编译执行、HTTPS/验签/篡改/断线、模拟双槽回滚、数据保留、资源事务、Windows暂存损坏、生产授权和App Server替身 |
| Web构建 | 本地与隔离静态构建均通过 |
| Edge E2E | 本地桌面/移动控制台通过；静态/stopwatch/子路径直接打开、任务/图片、零API/WS请求通过 |
| Windows包 | 实际打包Node24与ESM桥接/监督器；Node语法检查通过，PowerShell5.1 PlanOnly通过，Executed=false |
| ESP-IDF固件 | 0.2.0已真实编译；包含完整更新路径；当前应用约2.82MiB（0x2d1000），4MiB槽剩余30%；最终报告以build-security.json和日志为准 |
| SDK配置 | rollback和软件签名开启；硬件Secure Boot/eFuse anti-rollback/Flash及NVS密钥生成关闭；默认flash_args无photos.bin |
| GitHub Actions / Pages | 最终代码b2bf4c6的Windows测试/打包、Linux ESP-IDF v6.0.3构建/验签/配置检查/许可收集均成功；Pages自动部署成功，公网Edge移动验证通过 |
| 真实USB/刷写/电流/断电 | 未执行，设备未连接 |

远端记录：[最终CI](https://github.com/lezebomb/stopwatch/actions/runs/42586132112)、[Pages部署](https://github.com/lezebomb/stopwatch/actions/runs/42586677203)、[直接打开隔离演示](https://lezebomb.github.io/stopwatch/)。在线version.json已核对为0.2.0 / isolated-demo / b2bf4c6；公网移动Edge零脚本错误、零API/WS请求、无横向溢出。文档收尾提交不重跑代码构建。

发布包保留Node、ws、项目通知及实际固件组件许可；本地收集109份SDK/组件许可材料。

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
