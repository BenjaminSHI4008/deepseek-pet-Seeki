# dsh-pet-status

DeepSeek Harness 桌宠状态广播插件：订阅 harness 的会话事件流，把 agent 当前活动派生为一个状态，经本地 WebSocket 广播给桌宠客户端。

## 状态枚举

| 状态 | 含义 | 触发信号 |
|---|---|---|
| `idle` | 空闲 | 没有会话在运行 |
| `thinking` | 思考中 | `assistant/chunk` 的 `reasoning-delta` |
| `searching` | 搜索中 | `tool-call-delta` 且工具名含 `search` |
| `working` | 工作中 | `tool-call-delta`（其他工具） |
| `generating` | 生成中 | `assistant/chunk` 的 `text-delta` |

## WebSocket 协议

- 路径：`/api/pet.ws`（可用 `Config.path` 改）
- JSON 文本帧，服务器 → 客户端：

```json
{ "type": "status", "status": "idle" }
```

- 连接建立即推送一次当前状态（避免空窗）。
- v1 忽略客户端上行；v2 预留「桌宠输入 → harness」的上行位。

## 加载方式（不改官方 harness 仓库）

本插件是独立包，通过 cordis.yml 挂载。两种方式任选：

### 方式 A：软链到 harness

```sh
cd <deepseek-harness>
ln -s <deepseek-pet>/harness-plugin node_modules/dsh-pet-status
```

### 方式 B：npm/pnpm 安装

```sh
cd <deepseek-harness>
pnpm add <deepseek-pet>/harness-plugin
```

然后在你的 profile 的 cordis.patch.yml（或 `dsh --patch`）里加一行：

```yaml
- insert:
    - id: pet-status
      name: 'dsh-pet-status'
```

启动：

```sh
dsh web            # 或 dsh --profile web --patch /path/to/patch.yml
```

验证：

```sh
node -e 'const w=new WebSocket("ws://127.0.0.1:3080/api/pet.ws"); w.onmessage=e=>console.log(e.data)'
```

## 依赖

- `ws`（运行时）
- `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-host-apiproxy`（peer，由 harness 提供）
