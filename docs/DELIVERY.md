# 一次配置，持续交付

手机控制台和设备无线相册已经上线并通过热点实测。正式签名更新、真实 Muse 会话和 Windows 登录自启仍需验收。

## 维护者一次性配置

1. 受控环境离线创建RSA-3072发布私钥，只提交SPKI PEM公钥到 release/trust/stable-public.pem。设备与Windows信任根必须来自可信首次交付。
2. GitHub production-signing environment中设置 RELEASE_SIGNING_KEY_PEM secret，限制发布权限并按需审批。缺公钥/secret即失败关闭。
3. 固定 HTTPS 入口为 `https://fym.lezebomb.top`。首次部署时核对 DNS 和 HTTPS，公开 Pages 继续提供隔离演示。
4. VPS 获授权后，在独立用户目录放置首个可信门户制品。结构为 `versions/<首版目录>/`、`current.json`（内容为 `{"release":"<首版目录>"}`）、制品自带的 `bootstrap/`、`release-public.pem` 和 `production.env`。门户只监听 127.0.0.1，使用单独的域名入口；部署前确认不会影响已有代理和端口。
5. 在 `production.env` 中设置绝对 `STOPWATCH_DATA_DIR`，指向发布目录之外的持久目录。安装制品附带的用户级 `stopwatch.service` 和 `stopwatch-update.{service,timer}` 模板。先验证首版、持久数据和回滚，再启用 timer。`STOPWATCH_ENABLE_EXECUTION=0` 保持关闭，直到维护者明确授权。
6. 首次设备初始化先备份，核对现有分区、启动槽和 rollback Bootloader，再安装正式签名应用与信任根。已在使用的设备保留照片分区和个人配置。用两个递增签名版本依次验证成功升级和失败回滚，再启用稳定渠道。
7. 收礼人只需配网/Muse官方授权、手机一次配对、Windows一次图形安装和工作区授权，不维护仓库或CI。

信任根轮换需要双签名过渡和恢复计划，不能只改公钥文件或使用公开开发密钥，更不能盲目烧eFuse。

首次手动部署可在 Windows 用 `node scripts/build.mjs --production` 和 `node scripts/package-portal.mjs --without-dependencies` 准备门户包。在独立的 Linux 版本目录用 Node 24 运行 `npm ci --omit=dev` 补齐本机依赖。服务就绪后，维护者在私有 VPS 终端加载 `production.env` 并从当前版本目录运行 `node scripts/pair.mjs` 领取首次配对链接。该链接只在终端显示，两分钟有效。

手机控制台可以输入六位数字，也可以扫描二维码。两者共用同一张一次性票据，任意一种成功后另一种立即失效，仍受两分钟过期和服务端尝试次数限制。挂件和电脑授权使用各自独立的令牌。

当前 VPS 门户以 `stopwatch` 用户运行，版本和持久数据分别位于 `/srv/stopwatch/versions` 与 `/srv/stopwatch/data`。该用户的 `stopwatch.service` 只监听 `127.0.0.1:8787`。独立系统服务 `stopwatch-tunnel.service` 只为 `fym.lezebomb.top` 提供公网入口；两项服务可分别停止。隧道凭据由 VPS 本机权限保护，门户发布包不携带凭据。正式更新 timer 和远程执行尚未启用。

## 日常发布

`main` 自动测试和构建，Pages 继续部署隔离预览。更新 `release/config.json` 的版本，等待同一提交的 `main` CI 成功，再推送匹配的附注标签 `vX.Y.Z`。由 Actions 创建 Release。部分上传失败时，用原 Actions 制品重跑发布作业；已公开版本采用新版本号修复。

Actions 从同一个提交生成固件、Miao、Windows 桥接和门户。门户先用临时数据启动。发布作业校验四份签名、版本和构建号、所有受签名制品的大小及 SHA-256，再核对草稿上的上传结果。全部通过后一次公开为 `latest`。

四个入口为仓库 `releases/latest/download/` 下的 `firmware-manifest.json`、`miao-manifest.json`、`bridge-manifest.json` 和 `portal-manifest.json`。客户端验签后才下载并验证对应二进制。

门户由 VPS 用户级 timer 拉取签名版本。候选在临时数据库上启动成功后切换 `current.json`，重启 StopWatch 用户服务并检查确切构建。失败或上次切换未确认时恢复旧版本，失败序号隔离。自动下载的版本保留当前版和回滚版。网页在同域收到新构建号后刷新，保留登录状态，输入或上传时延后。GitHub 流水线无需 SSH 凭据。

## 信任与清单

Envelope使用RSA-3072、PSS-SHA256、32字节盐，签名覆盖base64解码的原始JSON字节。固定keyId=stable-v1。

Payload含schema/kind/channel/version/sequence、hardware/buildId、完整size/SHA256、HTTPS URL、publishedAt、compatibility。固件只接受固定布局c152-16m-dual4m-photos7m-v1、dataSchema1和IDF6.0.3；Windows限定protocol1/Node major24。

设备同时验证清单签名、完整文件哈希、ESP镜像签名与镜像版本，全部通过才切备用启动槽。不写Bootloader/分区表/NVS/product/photos。

## 数据与资源

程序、系统资源、个人数据生命周期分开。个人照片不进入公开Release。新增sw_updates命名空间只管理更新信息，不重设既有亮度/休眠偏好。

设备在充电、联网、空闲时独立检查 Miao。签名清单需匹配当前播放器帧和动作布局。下载包通过大小、SHA-256 和逐帧解码验证后，才写入照片分区内专用的 `miao0.pack` 或 `miao1.pack`，刷盘并读回校验，最后提交 NVS 指针。旧包在提交前仍可用。相册空间不足时可回收 Miao 缓存；所选包缺失或损坏时回退内置动画。固件内置版本相同或更新时直接使用内置包。变更帧或动作布局需由新版固件提供对应播放器。

授权照片、封面、彩蛋和显示设置继续使用私有 HTTPS 设备同步及现有相册事务。Windows 凭据和 VPS 持久数据库在发布目录之外。OTA 和稳定制品都不承载私人数据。

## Windows 后台

VBS启动WinForms图形安装，包内含Node24。仅当前用户LocalAppData和Startup快捷方式，不提权、不注册SYSTEM。凭据用DPAPI保存，经stdin传入子程序，不放命令行/普通日志。

supervisor与桥接分离，主动WSS，只恢复自身App Server线程映射及授权工作区。审批绑定请求ID、连接代数和TTL；授权失效停止无限重试。中转与Codex均在线才报告在线。

签名更新bundle置于独立版本目录，损坏/缺健康确认/进程退出回退，失败sequence隔离；配置、DPAPI、SQLite不在应用包。稳定bootstrap和Node24运行时的大版本迁移仍需单独迁移版本，不盲装不兼容bundle。

开始菜单提供设置/停止/撤销。当前仅完成打包、语法和PlanOnly验证，未实际安装或测试登录自启；Windows脚本发布策略、交互和真实账号恢复需交付验收，不绕过系统安全提示。

## 本地验证

npm run mock:updates启动127.0.0.1 HTTPS测试源，CA/测试私钥仅在忽略目录。测试显式信任该CA，不关闭TLS校验。npm test覆盖篡改、断线、模拟掉电、回滚、数据保留和C操作顺序。测试CA和开发私钥不能用作生产信任根。

安装/设置及DPAPI辅助进程仅为自己的脚本使用进程级ExecutionPolicy Bypass，不修改用户/系统永久策略；组织组策略仍优先。企业禁用脚本或WSH时须提供经组织认可的签名安装包，不能绕过管理策略。设置支持停止、直接向中转撤销自身授权和卸载程序，离线时移除本机凭据并明确提示补做云端撤销，私人数据保留。
