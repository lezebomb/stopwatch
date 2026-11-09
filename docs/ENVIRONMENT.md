# 本地环境检查

检查日期：2026-11-09，Asia/Shanghai。工作目录：`D:\stopwatch`，初始目录为空，远端 `lezebomb/stopwatch` 也无提交。没有覆盖既有项目。

| 项目 | 观察与处理 |
|---|---|
| Windows | 原生 x64，系统版本 10.0.26200.0 |
| Git | 2.53.0.windows.1，可用；sandbox 的 schannel 认证失败，按命令选用 openssl，无全局 SSL 配置修改 |
| Node | v24.13.0；提供本地 HTTP、WS 与 SQLite |
| Python | 原 PATH 的 WindowsApps 别名不能运行；用 uv 安装工程内 CPython 3.12.13 |
| CMake / Ninja / ESP32 编译器 | 原 PATH 未找到；用官方 idf_tools 安装至 `.tools/espressif` |
| ESP-IDF | 原 PATH 未找到；下载固定 v6.0.3 + 子模块至 `.deps/esp-idf` |
| WSL | wsl.exe 存在；状态查询返回 E_ACCESSDENIED，未据此断言已安装可用发行版；本项目选原生 Windows |
| Docker / Go | 未依赖；不为本轮修改系统安装它们 |
| 主机 C 测试 | `.tools/host/ziglang/zig.exe`，0.14.1 |
| 浏览器 | 已有 Edge，Playwright 创建独立 headless 测试上下文 |
| Codex | Desktop 捆绑 0.167.0-alpha.3.2；原生 PATH 为 0.164.0；以实际生成 schema 记录为准 |

工具安装无管理员系统配置、磁盘修改、WSL 功能开关、代理更改或公共端口开放。依赖下载使用官方源；GitHub 曾返回 504，乐鑫镜像曾出现 TLS EOF，随后重试成功。没有关闭证书验证。

默认执行沙箱在前几次命令后出现 `setup refresh had errors`，因此项目命令经自动批准检查后在原生可运行环境执行；只操作本工程与正常依赖缓存。CUA 内嵌浏览器也因同一沙箱初始化失败，浏览器验证改用独立 Edge 的 Playwright，已实际执行，不将 CUA 失败描述成浏览器测试通过。

`idf-env.ps1` 只为当前进程设置 PATH / IDF 环境及限定到本工程的 Git safe.directory；不写入用户全局配置。Python 的普通 pip 缓存可能使用标准用户缓存目录；固件工具、源码与运行数据保存在工程内。
