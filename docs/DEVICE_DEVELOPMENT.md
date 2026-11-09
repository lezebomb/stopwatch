# 当前实机开发入口

收礼人不使用这些工具。这里复用项目已有ESP-IDF Python，供当前Windows实机开发；没有安装系统服务或自启动。

## 后续增量修改

```powershell
./scripts/build-firmware.ps1
./scripts/flash-app.ps1 -Port COM5
./.tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe scripts/device-sync.py --port COM5 --info
```

flash-app只写应用；必须存在已核验备份和首次布局记录。设备身份、备份或分区指纹不匹配就拒绝，安全状态有变化就停下。不执行erase-flash/eFuse。首次FactoryAssets目录的flash_args可能包含photos，不能拿它日常重复初始化。新编译的相同镜像会在实际核验后跳过写入。

## 真实照片联调

```powershell
node tests/hardware-relay.fixture.mjs
./.tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe tests/hardware-device.py --port COM5 --data .data/hardware-relay
```

fixture只绑定127.0.0.1:8789，隔离mock profile，无真实执行桥接。通过现有照片API生成原创测试图，viewer身份和文件存.data。hardware-device为显式实物测试，不在CI运行；槽0含其他私人图时拒绝覆盖。覆盖断传、错误SHA、实际显示缓冲、默认图共存和重启保留，不能替代断电/OTA验收。

USB开发期自动同步已有相册与默认封面：

```powershell
./.tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe scripts/device-sync.py --port COM5 --watch --relay http://127.0.0.1:8789 --session-file .data/hardware-relay/viewer.json --data .data/hardware-relay
```

不会把Mock任务写为设备真实状态；只接受production来源的真实Codex状态。已相同的图片按设备hash跳过，断线退避重试，授权失效或相册需恢复/容量不足时明确停下。此工具当前同步新增/替换与封面；设备端删除联动和Wi-Fi无线传输仍待接线。逻辑12槽受实际写时复制空间约束，不能以擦旧数据换容量。

## 真实Codex与音频

hardware-codex.mjs是显式、使用本机已有登录的一轮实物联调，不在CI运行；提示只回复固定短句、不使用工具或读写文件，不开网络端口。真实任务的思考/工作/完成事件通过USB确认到设备；结束后报告离线，不接管Desktop会话。

hardware-audio.py复用SDK离线MP3和声学回环，会短暂以音量30播放测试音并扫描麦克风增益，之后恢复原设置。没有保存/发送语音。听感必须由现场人员确认。

## 尚未交付

当前手机公开域名是隔离演示。真实手机控制需要受保护HTTPS中转；本轮没有VPS操作。Muse需本人官方授权，配网/电池拔插/听感待现场。生产签名和域名缺失时，正式OTA与Windows生产安装继续拒绝启用。实机最新证据见HARDWARE_TEST.md，私有报告只留.data。
