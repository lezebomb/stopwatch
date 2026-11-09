# StopWatch 协议 v1

所有传输均为 UTF-8 JSON，最多 64 KiB 一帧。真实部署必须 TLS。浏览器为同源 HttpOnly cookie，桥接使用单独 Bearer 身份；当前只在 loopback 开发使用 HTTP。

```json
{"v":1,"id":"uuid","type":"task","payload":{"id":"thread-id","mode":"mock","state":"working","title":"测试照片","operation":"Mock：编辑项目文件"}}
```

中转追加单调 `seq`、服务端 `time`。唯一 `id` 去重，WS `{type:"event",event:...}` 推送；客户端重连携带 `/events?after=seq`，REST `/api/events?after=seq` 支持补同步。WS 首帧始终给权威 `{type:"snapshot",state:...}`；历史超过缓存时以快照恢复任务、照片和设置。额度事件有 `mode:mock` 与 primary/secondary 窗口。不得推导不存在的任务百分比。

浏览器 `POST /api/commands`：`id` 为幂等键，`action` 是 `start|continue|steer|interrupt|approve`；后四种带 taskId。`start/continue/steer` 带 text，审批带 approvalId 和 accept/decline。返回 202 表示排队，不表示执行成功。命令错误通过 `commandError` 事件返回。

relay→bridge：`{type:"command",command:{...}}`。bridge→relay：`{type:"ack",id}`。桥接在 SQLite 持久记录已消费命令，重复传输不执行第二次；重连重发 relay 未确认命令。任务事件先写桥接 outbox，收到 `{type:"eventAck",id}` 后删除；重复收到的事件由 relay UNIQUE(id) 拒绝。

桥接每十秒发送 `{type:"heartbeat"}`；超过 35 秒视为离线。指数退避含抖动，最高 15 秒。桥接重启后恢复持久任务：未结束的 Mock 工作转为 interrupted，待审批保持等待；不声称旧进程仍在执行。真实执行需要与 App Server 再核对轮次。

照片上传为原始图像 body，最多 8 MiB / 2400 万像素；服务端按实际解码数据验证，不信任扩展名。返回资源 ID，只允许固定 UUID 路径；`GET /api/photos/ID.jpg` 和 `.rgb565` 需认证。RGB565 为 466×466 little endian，434312 字节。照片数量、JPEG+RGB565 总量都计入预算。
