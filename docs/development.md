# 开发者指南

面向希望扩展功能点的开发者：了解架构、文件职责，以及「加一个动作 / 加一个鼠标状态 / 加一个拖拽方向」的正确改法。

## 架构概览

项目由两部分组成，通过本地 WebSocket + 文件系统协作：

```
harness (DeepSeek Harness)
   │ 事件流
   ▼
dsh-pet-status 插件 (harness-plugin/src/index.ts)
   │ WebSocket /api/pet.ws 广播任务状态
   │ 读写 pet.config.json；提供 HTTP API 与 /pet/settings 配置页
   │ 拉起/关闭 Electron 子进程
   ▼
Electron 桌宠应用 (根目录)
   main.cjs  ── 主进程：透明窗口 + IPC 拖拽 + WebSocket 客户端
   preload.cjs ── 桥接：window.petAPI
   index.html + renderer.js ── 渲染层：画布 + 精灵状态机
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `harness-plugin/src/index.ts` | 插件：状态广播、HTTP API（配置/帧上传/删除/重启/配置页）、桌宠子进程管理、`ChatService`（会话/工作区/流式回传） |
| `harness-plugin/settings.html` | 配置页（自包含 HTML/CSS/JS），读写 `/api/pet.config` |
| `main.cjs` | Electron 主进程（透明窗口、IPC 拖拽、连接状态流、聊天窗口与工作区管理） |
| `preload.cjs` | contextBridge 暴露 `petAPI`（dragStart/dragMove/onStatus/getStatus/openChat/cancelChat） |
| `renderer.js` | 渲染层：加载配置、预加载帧、精灵状态机、鼠标交互、气泡渲染、双击检测 |
| `chat-window.cjs` | 聊天窗口管理类（创建/显示/收起/展开/关闭/推送） |
| `chat.html` / `chat-preload.cjs` | 聊天框 UI + 桥接（发消息/新对话/打断/打开完整记录） |
| `pet.config.json` | 全部行为配置（见 [`docs/config.md`](config.md)） |
| `Deepseek/` | 精灵素材（`animations/<动作>/south/frame_NNN.png`、`rotations/`、`metadata.json` 素材元数据） |
| `scripts/install-harness-plugin.sh` | 一键安装插件到 dsh web profile |
| `scripts/normalize-animations.mjs` | 素材标准化（GIF 拆帧 + 帧序列校验） |

## 对话（聊天）链路

双击桌宠 → 聊天框 → harness 对话，数据流：

1. `renderer.js` 双击检测（`DoubleClickDetector` 类）→ `petAPI.openChat()`；
2. `main.cjs` 弹工作区选择（首次）→ 打开 `chat-window.cjs` 聊天窗；
3. `chat.html` 发送 → IPC `chat-send` → `main.cjs` 经 `/api/pet.ws` 发 `{type:'chat', text, workspacePath}`；
4. 插件 `ChatService.send()`：`workspace.create` → `session.create` → `session.prompt`（RPC 返回信封 `{result:{ok,value}}`，需解包 `result.value`）；
5. 插件从 `events.mux` 提取 `assistant/chunk`(text-delta)/`assistant/message`/`turn/end`，经 WS 回传 `chat-delta/message/done`；
6. `main.cjs` 转发给聊天窗；`chat-done` 时展开聊天框展示输出。

打断：运行中气泡右键 → `session.cancel`。新对话：`chat-new` → 重置会话 id。

## 渲染层数据流

`renderer.js` 启动流程：

1. `fetch('./pet.config.json')` 读配置；
2. 依 `actions` 构建帧路径，预加载所有帧（坏帧跳过）；
3. 建立 `ACTIONS`（intro/loop 帧切片）与 `pickPlay`（随机选动作）；
4. 状态机 `setState()` 切换动作，`tick()` 按 fps 推进帧，`drawFrame()` 绘制（含 `flipX/flipY` 镜像）；
5. `renderStatus()` 收到 WebSocket 状态 → 更新气泡 + 触发任务状态动作；
6. 鼠标事件驱动角色状态（点击/拖动/超时）。

## 如何添加一个新动作

1. 放帧：`Deepseek/animations/<动作名>/south/frame_000.png …`（三位零填充；GIF 可先跑 `node scripts/normalize-animations.mjs`）；
2. 在 `pet.config.json` 的 `actions` 加一条 `{ "label": "...", "fps": 5, "folder": "<动作名>", "count": N }`；
3. 挂触发点：在 `characterStates`（默认/点击/拖动某方向/超时）或 `statuses.*.actions` 里引用该动作 id。

（也可全程用配置页「动作帧管理 → 添加动作」完成上传，再到相应板块挂触发点。）

## 如何添加一个新的鼠标状态（如「双击」）

鼠标状态是「渲染层 + 配置 + 配置页」三处联动：

1. **渲染层** `renderer.js`：新增事件监听与触发逻辑（如双击需 mousedown/mouseup 计时）；
2. **配置**：在 `characterStates` 加对应键（如 `doubleClick: { play: [], returnTo: "idle" }`）；
3. **配置页** `settings.html`：在「角色状态」板块加对应卡片 + `normalize()` 补默认 + 保存/删除引用同步。

## 如何添加一个新的拖拽方向

当前支持四方向（`left/right/up/down`）。加斜向：

1. `renderer.js` 的 `classifyDirection()` 增加方位分类（如 `ne/nw/se/sw`）；
2. `pet.config.json` 的 `drag.directions` 加对应键；
3. `settings.html` 的方向卡片 + `normalize()` + 保存/删除引用同步。

## 配置页（settings.html）模式

- 每个板块 `render()` 用 innerHTML 生成表单，字段带 `data-*` 属性；
- 保存时 `save` 监听器遍历 `data-*` 收集回 `config` 对象，再 `PUT /api/pet.config`；
- 随机池统一用 `.chips`（`chipsHtml()` 渲染，事件委托处理 `data-rm` 删除 / `data-*-addbtn` 添加）。

## 验证

- 独立运行：`npm install && npm start`（桌宠 + 右键配置页）；
- 随 harness：`bash scripts/install-harness-plugin.sh` 后 `pnpm dsh web`；
- HTTP API 可用 `curl http://127.0.0.1:3080/api/pet.config` 检查配置；
- 无头验证渲染/交互可用 Playwright 加载 `index.html`（mock `window.petAPI`）。

## 约定

- 帧目录 `<动作>/south/frame_NNN.png`，`NNN` 三位零填充，`count` 与实际帧数一致；
- 新增动作名若含中文会被 `sanitizeFolder` 转为下划线目录名（见 `harness-plugin/src/index.ts`），建议用英文/拼音命名动作 id；
- 配置键值遵循 [`docs/config.md`](config.md) 的 schema，改 schema 需同步改 `renderer.js` 与 `settings.html`。
