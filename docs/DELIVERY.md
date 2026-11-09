# 一次配置，持续交付

本轮没有接入实物、真实账号或VPS，也没有注册开发电脑常驻程序。

## 维护者一次性配置

1. 受控环境离线创建RSA-3072发布私钥，只提交SPKI PEM公钥到 release/trust/stable-public.pem。设备与Windows信任根必须来自可信首次交付。
2. GitHub production-signing environment中设置 RELEASE_SIGNING_KEY_PEM secret，限制发布权限并按需审批。缺公钥/secret即失败关闭。
3. 设置release/config.json.productionOrigin为固定HTTPS域名；当前null，生产控制台包拒绝构建。公开Pages仅演示。
4. 后续获VPS部署授权后先检查已有服务、端口和TLS入口，不覆盖代理配置，不停止代理，不假定443空闲。中转只监听127.0.0.1。
5. 持久data置于代码版本目录之外，使用用户级服务和固定Origin；STOPWATCH_ENABLE_EXECUTION=0默认不执行，绑定验收后由维护者明确启用。
6. 首次设备初始化先备份，安装正式签名/公钥和rollback Bootloader。仅首次显式-FactoryAssets写内置照片，以后不重写默认SPIFFS。
7. 收礼人只需配网/Muse官方授权、手机一次配对、Windows一次图形安装和工作区授权，不维护仓库或CI。

信任根轮换需要双签名过渡和恢复计划，不能只改公钥文件或使用公开开发密钥，更不能盲目烧eFuse。

## 日常发布

main push自动测试和构建，成功后部署隔离Pages；PR没有发布secret。更新版本并发布匹配vX.Y.Z的正式Release；pre-release不发布稳定更新。

Signed stable release复跑验证后生成固件、Windows和生产控制台制品；先上传二进制再上传签名清单，失败不降级无签名。当前没有创建正式Release。

发现入口为仓库releases/latest/download下的firmware-manifest.json和bridge-manifest.json。构建期间或缺资产404时保留旧版本并退避，不把Release存在当作可安装。

生产控制台仅打包为Actions制品，本轮没有SSH、DNS或VPS执行步骤。后续获授权可增加受保护部署job：独立版本目录、健康检查、切current、失败回previous，持久data不进入版本目录。现有代理不属于可修改范围。

## 信任与清单

Envelope使用RSA-3072、PSS-SHA256、32字节盐，签名覆盖base64解码的原始JSON字节。固定keyId=stable-v1。

Payload含schema/kind/channel/version/sequence、hardware/buildId、完整size/SHA256、HTTPS URL、publishedAt、compatibility。固件只接受固定布局c152-16m-dual4m-photos7m-v1、dataSchema1和IDF6.0.3；Windows限定protocol1/Node major24。

设备同时验证清单签名、完整文件哈希、ESP镜像签名与镜像版本，全部通过才切备用启动槽。不写Bootloader/分区表/NVS/product/photos。

## 数据与资源

程序、系统资源、个人数据生命周期分开。个人照片不进入公开Release。新增sw_updates命名空间只管理更新信息，不重设既有亮度/休眠偏好。

ResourceStore只接受签名system命名空间：逐文件大小/哈希、临时下载、不可变对象、previous/active指针和恢复；拒绝路径穿越、重复文件、私人命名空间与不足的写时复制空间。7MiB不可能同时存两份6MiB相册，必须推迟而非擦除。设备资源网络传输接线仍待实现，事务机制当前在电脑端执行测试。

## Windows 后台

VBS启动WinForms图形安装，包内含Node24。仅当前用户LocalAppData和Startup快捷方式，不提权、不注册SYSTEM。凭据用DPAPI保存，经stdin传入子程序，不放命令行/普通日志。

supervisor与桥接分离，主动WSS，只恢复自身App Server线程映射及授权工作区。审批绑定请求ID、连接代数和TTL；授权失效停止无限重试。中转与Codex均在线才报告在线。

签名更新bundle置于独立版本目录，损坏/缺健康确认/进程退出回退，失败sequence隔离；配置、DPAPI、SQLite不在应用包。稳定bootstrap和Node24运行时的大版本迁移仍需单独迁移版本，不盲装不兼容bundle。

开始菜单提供设置/停止/撤销。当前仅完成打包、语法和PlanOnly验证，未实际安装或测试登录自启；Windows脚本发布策略、交互和真实账号恢复需交付验收，不绕过系统安全提示。

## 本地验证

npm run mock:updates启动127.0.0.1 HTTPS测试源，CA/测试私钥仅在忽略目录。测试显式信任该CA，不关闭TLS校验。npm test覆盖篡改、断线、模拟掉电、回滚、数据保留和C操作顺序。测试CA和开发私钥不能用作生产信任根。

安装/设置及DPAPI辅助进程仅为自己的脚本使用进程级ExecutionPolicy Bypass，不修改用户/系统永久策略；组织组策略仍优先。企业禁用脚本或WSH时须提供经组织认可的签名安装包，不能绕过管理策略。设置支持停止、直接向中转撤销自身授权和卸载程序，离线时移除本机凭据并明确提示补做云端撤销，私人数据保留。
