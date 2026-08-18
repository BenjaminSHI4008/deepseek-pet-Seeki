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

验证（应收到 `{"type":"status","status":"idle"}`）：

```sh
node -e 'const w=new WebSocket("ws://127.0.0.1:3080/api/pet.ws"); w.onmessage=e=>console.log(e.data)'
```

## 依赖

- `ws`（运行时）
- `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-host-apiproxy`（peer，由 harness 提供）
