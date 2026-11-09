# 后续实机联调结果（2026-11-09）

| 功能 | 本轮实机结果 | 后续 |
|---|---|---|
| 原厂恢复 | 完整16MiB备份、设备digest和SHA256核验通过，原厂版本/布局留本地 | 保密保留；未执行整片恢复 |
| 显示/触摸/按键 | 用户已确认正常，SDK底层驱动保持 | 长期老化待测 |
| 真实照片 | 原有上传API生成RGB565，经USB写SPIFFS；设备实际显示缓冲SHA256一致 | 手机无线链路尚未接线 |
| 照片事务 | 断传、错误SHA拒绝激活；默认照片共存；重启与两次后续app-only写入后封面仍在 | 真实断电边界待测，未替代OTA断电验收 |
| Codex | 已登录本机App Server完成一轮短任务；真实thinking/working/completed经USB到设备；40秒空闲堆33567字节稳定 | 手机生产入口、持续后台和登录自启待配置/验收 |
| 音频 | SDK离线MP3与8档声学回环完成，麦克风检测到1kHz测试音；原音量/开关/增益已恢复 | 用户不在现场，听感未确认；Muse账号会话未验证 |
| 电源 | 充电下临时设原生10秒休眠阈值，50秒实测仍亮且空闲计时前进；亮度偏好保留，休眠设置已恢复；电池20%上限仅模型验证 | 物理拔插/电池亮度/续航等用户在场再测 |
| OTA | 生产更新仍关闭，未运行远程升级；沿用官方签名/双槽/回滚代码 | 正式信任根、域名、实机回滚/断电均待测 |

实机私有报告：`.data/hardware-photo-test.json`、`.data/hardware-real-codex-report.json`、`.data/hardware-audio-report.json`、`.data/hardware-power-report.json`。这些报告、原始串口、SQLite和照片均不提交。

日常实测改用 `./scripts/flash-app.ps1 -Port COM5`：检查原设备USB身份、原厂备份SHA256、首次布局指纹、实时安全状态及开发镜像签名，只写0x20000应用槽。镜像相同会核验并跳过写入。它不会消费可能仍含首次photos镜像的flash_args。不要日常运行初次安装的全量flash命令。

USB命令复用官方console hook，不改变黄键录音管线，也没有新增公网命令服务。照片用不可变文件、全量SHA256和NVS active/previous相册根；空间不足保留旧数据。根丢失时先恢复上一代；无法恢复则保留全部文件并禁写，不盲目回收私人图片。物理容量要同时容纳默认图、当前图、上一代和临时文件，12个逻辑槽不保证任意12张都能同时写入。

以下为首次阶段记录和操作手册，旧“待硬件”条目以上表具体结果为准。
# 实机阶段记录（2026-11-09）

- 已实测：ESP32-S3 rev0.2、16MiB Flash、8MiB PSRAM；原厂 StopWatch-UserDemo cf51acc / IDF5.5.4；CST820、M5PM1、M5IOE1和ES8311初始化正常。USB标识仅留本地。
- 已完整读取16MiB原厂镜像，经设备端digest核验成功，并保存SHA256、分区报告及恢复基线日志于Git忽略的 `.data/backups/20261109-171219/`。没有上传备份、NVS、MAC或授权数据。
- 已核对原厂表0x8000与Muse表0x10000的差异。目标NVS 0x11000..0x1d000原本全FF；首次安装照片区会覆盖原厂storage等区域，完整备份包含被替换内容。可通过ROM下载模式整片写回已核验备份；未执行整片擦除或eFuse写入。
- 首次开发烧录：Bootloader、分区表、otadata、应用、photos五段写入及校验成功；不是正式生产OTA版本。
- 设备启动0.2.0 / ESP-IDF6.0.3，8MiB PSRAM初始化通过；45秒日志没有panic/复位循环。音频芯片初始化成功，Muse未做账号绑定。
- 用户已实际确认：照片、触摸、点按换图、滑动和实体按键均正常。电池拔线、声音质量、长期运行、真实账号和OTA故障仍需单独验收。
- 首次启动内部空闲堆约15.7KiB，需要后续减少未启用OTA时的常驻内存；不能据此宣称网络并发稳定或无长期泄漏。
- 构建脚本已复用匹配CMake缓存；同配置增量实测21.2秒，不清理构建目录。

下面旧阶段“未连接/待硬件”是历史记录，以本节明确结果为准。
# 0.2.0 OTA专用验收补充

本轮没有执行任何USB访问、复位、刷写或断电实验。下列项目均待实机验证。

- 首次安装前完整备份，确认C152/16MiB/8MiB PSRAM及实际Bootloader、分区表。旧开发信任根不能假定能直接接收正式密钥的更新。
- 首次照片初始化才使用 -FactoryAssets；正常构建默认不写photos.bin。升级前记录照片哈希/封面、彩蛋、Wi-Fi、Muse和设备授权，之后逐项比对，不在公开日志放Token。
- 正式交付需正式公钥和签名版本。核验rollback=on，硬件Secure Boot、Flash/NVS eFuse密钥生成和eFuse anti-rollback=off；不烧eFuse。
- 测试健康更新进入备用槽，等待UI/照片/服务健康确认，再检查当前槽VALID；重启仍用新版本且封面/授权不变。
- 使用专门故障固件令健康确认失败，验证Bootloader回旧版本、显示回滚并隔离失败版本；不使用生产账号测试危险命令。
- 测试假签名、错误哈希/大小、错板型/布局、降级、HTTP、网络掉线；均不得激活新槽，旧照片和应用可用。
- 在可恢复、有备份条件下分别测试清单前、下载中、镜像验签后、写otadata附近、首次启动期间断电。软件故障注入不代替这些实测。
- 电池照片页观察Wi-Fi不被更新拉起；充电后自动连接已存热点并限频检查。低电、通话、Codex交互和不稳定网络推迟安装，结束后恢复。
- 先测Windows用户级安装、登录自启、后台重连、停止/撤销/卸载及更新包损坏恢复；不将开发电脑PlanOnly称为实际安装成功。

下面保留首次连接、备份和恢复流程。正常OTA只更新应用，不跟随这些有线步骤反复初始化照片。
# 首次 USB-C 接入与硬件验证

**本轮没有连接、重置、刷写或擦除设备。以下命令为下一阶段操作手册，不能视为执行记录。**

## 1. 连接和识别

1. 使用可靠的数据 USB-C 线接电脑，先保持原装电池和机壳不动。
2. 在设备管理器查看新增端口；PowerShell 可运行 `[System.IO.Ports.SerialPort]::GetPortNames()` 比较连接前后端口。
3. 记录包装 C152、设备界面版本、USB VID/PID、COM 号；ESP32 原生 USB 303a:1001 只能证明 USB 类型，不能单凭它断定是 StopWatch。
4. 原固件如提供关于页面，先拍照记录版本。确认确为 16MB Flash / 8MB PSRAM 的 StopWatch；不要刷入其他板型。

## 2. 优先备份

在本工程 PowerShell 中加载 `. ./scripts/idf-env.ps1`。把 COM7 替换为实际识别端口。esptool 访问会进入 ROM/复位，必须在允许进行硬件操作后执行。

```powershell
python -m esptool --chip esp32s3 --port COM7 chip-id
python -m esptool --chip esp32s3 --port COM7 flash-id
New-Item -ItemType Directory -Force .data/backups
python -m esptool --chip esp32s3 --port COM7 read-flash 0x0 0x1000000 .data/backups/original-16MB.bin
Get-FileHash .data/backups/original-16MB.bin -Algorithm SHA256
```

完整备份如成功应包含原分区和配置；加密 Flash / 读保护可能导致不可用，必须报告真实结果。文件可能含 Wi-Fi 与授权信息，只保存在忽略目录并安全保管。若查询发现 Secure Boot、Flash Encryption 或未知 eFuse 状态，停止并先评估，不试烧 eFuse、不强刷。

## 3. 检查构建产物后再刷写

```powershell
./scripts/build-firmware.ps1 -FactoryAssets
Set-Location .deps/muse/esp32
python "$env:IDF_PATH/tools/idf.py" -B D:/stopwatch/firmware/build -p COM7 flash
python "$env:IDF_PATH/tools/idf.py" -B D:/stopwatch/firmware/build -p COM7 monitor
```

刷写会覆盖原厂应用和分区表，且本项目有新照片分区；不要把当前 Muse 的 NVS 格式与原厂配置兼容当作事实。首次升级默认写应用与 photos 镜像，但不能保留用户后续新增照片时还反复写默认 SPIFFS：后续 OTA 应只更新应用或走迁移程序。先核对 flash_args，保存备份。禁止默认 `erase-flash`。监视器 Ctrl+] 退出；进入监视器可能重置设备。

## 4. 功能验收表

| 项目 | 方法 / 成功条件 | 当前结果 |
|---|---|---|
| 启动 / 存储 | 无 panic / 重启循环；SPIFFS、NVS、8MB PSRAM 初始化成功 | 待硬件 |
| 圆屏 | 466×466 正确、颜色无 RGB565 反序、圆边缘及 x gap 正常 | 待硬件 |
| 触屏 | 点击切照片、滑动切页、退出 Muse、长按轮播 | 待硬件 |
| 按键 | USB 向下时黄键录音，松开发送；蓝键扬声器；按键无粘连 | 待硬件 |
| 官方 Muse | 收礼人账号、正式 Token、原绑定流程；断网重连、回复文字与播放 | 待账号+硬件 |
| 麦克风/扬声器 | 录音和播放无破音；10分钟工作无缓冲泄漏；拔网后可取消 | 待硬件 |
| 电源 | 实际 USB / 充电状态、电压、电量；低电量变暗、休眠和按键唤醒 | 待硬件 |
| 照片离线 | Wi-Fi 关闭仍显示内置照片；断电重启保留默认封面 | 待硬件 |
| Flash 与内存 | 4MiB app 槽通过；连续切图、音频/网络并发下内部 DMA 堆仍足够 | 待硬件 |
| 续航 | 原装450mAh；记录30%/50%亮度、静态/轮播、Wi-Fi开关条件 | 未测量 |

照片常亮意味着显示电源与 CPU 的必要工作仍存在；屏幕关闭且无任务时才允许自动 Light-sleep。Modem-sleep 只控制 Wi-Fi 无线活动。Deep-sleep / PMIC 关机时不显示照片。不要把官方 PowerDemo 数据充当这台设备或本固件的实测值。

## 5. 恢复

先保存日志和失败配置。正常原生 USB 刷写失败时使用官方 StopWatch/M5Burner 恢复说明核对进入下载模式的步骤，不能猜电源键 GPIO 或要求拆机短接。确认串口、固件和分区后，必要时用已验证的完整备份恢复（经用户授权后）：

```powershell
python -m esptool --chip esp32s3 --port COM7 write-flash 0x0 D:/stopwatch/.data/backups/original-16MB.bin
```

备份加密、型号不符或读保护时不得盲目使用此命令。恢复过程中不改代理，不拆换电池，不用 PPK2 给未知接线供电。
