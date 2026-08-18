# dsh-pet-status

DeepSeek Harness 桌宠插件：订阅 harness 事件流，把 agent 活动收敛为**任务状态**经本地 WebSocket 广播给桌宠；同时作为**桌宠管理器**——自动拉起/关闭桌宠、读写配置、提供帧管理与配置页。

## 任务状态枚举（三态 + 离线）

| 状态 | 含义 |
|---|---|
| `running` | 至少一个会话在运行（任务进行中） |
| `completed` | 没有会话在运行，且最近一次 turn 正常结束（任务完成） |
| `terminated` | 没有会话在运行，且最近一次 turn 以 `error`/`aborted` 结束（任务截止） |
| `offline` | 桌宠端未连接（由客户端在 WebSocket 断开时本地合成，非插件广播） |

> `completed` 与 `terminated` 的区分来自 mux 流的 `turn/end` 事件：`reason.kind` 为 `error` 或 `aborted` 时记 `terminated`，否则 `completed`。running 归零后延迟 80ms 再广播，以等待 `turn/end` 先到（两条事件流投递顺序不保证）。

## WebSocket 协议

- 路径：`/api/pet.ws`（可用 `Config.path` 改）
- JSON 文本帧，服务器 → 客户端：

```json
{ "type": "status", "status": "running" }
```

- 连接建立即推送一次当前状态（避免空窗）。
- v1 忽略客户端上行；v2 预留「桌宠输入 → harness」的上行位。

## HTTP API（插件作为桌宠管理器）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/pet.config` | 读 `<petDir>/pet.config.json` |
| `PUT` | `/api/pet.config` | 写 `<petDir>/pet.config.json` |
| `POST` | `/api/pet.frames` | 上传/替换动作帧（base64 JSON，校验 PNG + 尺寸上限 256px，先全量校验再写盘） |
| `DELETE` | `/api/pet.action` | 删除动作（连带删帧目录 + 引用安全回退） |
| `GET` | `/pet/frames/<folder>/<file>` | 帧图片预览（路径穿越防护） |
| `POST` | `/api/pet.restart` | 重启桌宠子进程 |
| `GET` | `/pet/settings` | 配置管理页（自包含 HTML） |

## 加载方式（一键安装到 dsh web profile）

插件依赖 harness 的 `@deepseek-ai/dsh-*` 包，这些包在 `~/.dsh/profiles/node_modules/` 里，所以插件要装到那里（软链到外部目录不行）。

直接运行桌宠仓库里的安装脚本：

```sh
cd <deepseek-pet>
bash scripts/install-harness-plugin.sh
```

脚本会：① 把插件复制到 `~/.dsh/profiles/node_modules/dsh-pet-status/`；② 写进 profile 的依赖清单；③ 在 `cordis.patch.yml` 里挂载插件并开启 `autoStart`。

## 自动拉起桌宠

插件配置：

```yaml
- insert:
    - id: pet-status
      name: 'dsh-pet-status'
      config:
        autoStart: true          # 启动 harness 时自动拉起桌宠
        petDir: '<deepseek-pet>' # 桌宠应用目录
        path: '/api/pet.ws'      # WebSocket 路径（可省略）
```

之后直接：

```sh
cd ~/Projects/deepseek-harness
pnpm dsh web        # 会同时：加载插件 + 自动拉起桌宠
```

停止 `dsh web`（Ctrl+C）时，桌宠会随之一并关闭。

验证（应收到 `{"type":"status","status":"completed"}`）：

```sh
node -e 'const w=new WebSocket("ws://127.0.0.1:3080/api/pet.ws"); w.onmessage=e=>console.log(e.data)'
```

## 依赖

- `ws`（运行时）
- `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-host-apiproxy`（peer，由 harness 提供）
