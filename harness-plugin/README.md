# dsh-pet-status

DeepSeek Harness 桌宠状态广播插件：订阅 harness 的 `host/session-status`（agent running 翻转），把状态收敛为两态，经本地 WebSocket 广播给桌宠。

## 状态枚举（两态）

| 状态 | 含义 |
|---|---|
| `working` | 至少一个会话在运行（agent 工作中） |
| `idle` | 没有会话在运行（任务完成 / 空闲） |

桌宠端据此显示「Deep diving...」（working）和「已完成」（idle，且此前在工作）。

## WebSocket 协议

- 路径：`/api/pet.ws`（可用 `Config.path` 改）
- JSON 文本帧，服务器 → 客户端：

```json
{ "type": "status", "status": "working" }
```

- 连接建立即推送一次当前状态（避免空窗）。
- v1 忽略客户端上行；v2 预留「桌宠输入 → harness」的上行位。

## 加载方式

插件依赖 harness 工作区里的 `@deepseek-ai/dsh-*` 包，所以**必须放在 harness 的模块解析路径内**（软链到外部目录不行——模块会从外部目录解析，找不到 `@deepseek-ai/*`）。

推荐做法：把插件复制进 harness 工作区作为一个临时包。

```sh
cd <deepseek-harness>
mkdir -p packages/extensions/pet-status/src
cp <deepseek-pet>/harness-plugin/src/index.ts packages/extensions/pet-status/src/index.ts
```

再在 `packages/extensions/pet-status/package.json` 写：

```json
{
  "name": "dsh-pet-status",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "ws": "^8.18.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-host-webserver": "workspace:^",
    "@deepseek-ai/dsh-host-apiproxy": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-host-webserver": "workspace:^",
    "@deepseek-ai/dsh-host-apiproxy": "workspace:^",
    "@types/ws": "^8.5.12"
  }
}
```

然后：

```sh
pnpm install
```

在 profile 的 cordis.patch.yml（或 `dsh --patch`）里加一行：

```yaml
- insert:
    - id: pet-status
      name: 'dsh-pet-status'
```

启动：

```sh
dsh --profile web --patch /path/to/patch.yml
```

验证（应收到 `{"type":"status","status":"idle"}`）：

```sh
node -e 'const w=new WebSocket("ws://127.0.0.1:3080/api/pet.ws"); w.onmessage=e=>console.log(e.data)'
```

## 依赖

- `ws`（运行时）
- `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-host-apiproxy`（peer，由 harness 提供）
