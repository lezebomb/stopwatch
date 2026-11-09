# 发布信任根

正式发布前由维护者离线创建 RSA-3072 发布密钥，仅将公钥放在 `stable-public.pem` 并提交审核；私钥存入受保护 GitHub environment `production-signing` 的 `RELEASE_SIGNING_KEY_PEM` secret。不可使用 Muse 已公开的开发密钥。

公钥用于 RSA-PSS/SHA-256 签名清单验证，私钥也为官方 ESP Secure Boot v2 软件镜像签名流程签名。运行中的正式固件同时要求清单签名、文件 SHA-256 和 ESP-IDF 镜像签名全部有效。不启用硬件 Secure Boot、Flash Encryption、eFuse anti-rollback。

当前没有配置正式公钥或真实私钥；稳定发布会失败关闭。开发构建只生成忽略目录中的开发测试信任根，默认不自动联网更新，不能交付为正式安全固件。设备首次交付应安装包含正式公钥和签名配置的版本；旧公开开发密钥不能当作生产信任根。
