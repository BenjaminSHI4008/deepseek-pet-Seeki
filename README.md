# DeepSeek Pet

> 一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**桌面宠物（桌宠）插件**：透明、无边框、置顶的像素风角色悬浮在桌面上，跟随 agent 任务状态实时切换动画与头顶气泡。

## 项目定位

本项目定位为 DeepSeek Harness 的一个 Plugin（社区项目，非官方）。它由两部分组成：

1. **`dsh-pet-status` 插件**（`harness-plugin/`）——随 `pnpm dsh web` 加载，订阅 harness 事件流，把 agent 活动收敛成任务状态经 WebSocket 广播，并自动拉起/关闭桌宠；
2. **Electron 桌宠应用**（仓库根目录）——透明置顶窗口 + 2D 像素精灵状态机，配置驱动。

## 特性

- **透明、无边框、置顶**的桌面窗口（`transparent` + `frame:false` + `alwaysOnTop`）。
- **2D 精灵状态机**：待机（呼吸）/ 开心 / 拖动（走路）/ 打哈欠→睡觉，帧动画循环、intro 播一次。
- **与 agent 状态联动**：头顶气泡随任务状态显示「Deep diving... / Completed / Stopped / Offline」。
- **交互**：拖拽移动（走路）、单击（开心）、超时自动睡觉、睡眠中点击唤醒。
- **配置驱动**：状态文案/颜色、动画帧率/帧数、触发规则全部声明在 `pet.config.json`，无需改渲染代码。
- **可视化配置页**（`/pet/settings`）：编辑任务状态、角色状态、角色动作，上传/替换/删除动作帧。

## 状态模型（三个维度，已拆分）

桌宠的「状态」拆成三个正交维度，避免混用：

**① 任务状态 Task Statuses**（来自 harness，决定头顶气泡）：

| 键 | 含义 | 默认气泡 | 颜色 |
|---|---|---|---|
| `running` | 任务进行 | Deep diving... | 蓝 |
| `completed` | 任务完成 | Completed | 绿 |
| `terminated` | 任务截止（报错/手动停止） | Stopped | 红 |
| `offline` | 离线（未连 harness） | Offline | 灰 |

**② 角色动作 Character Actions**（桌宠自身动画）：

| 键 | 标签 | 动画目录 |
|---|---|---|
| `idle` | 待机 | `Breathing_Idle` |
| `happy` | 开心 | `Happy` |
| `walk` | 拖动 | `Crouched_Walking` |
| `sleep` | 睡觉 | `Close_eyes_and_sleeping` |

任务状态可以「触发」一个或多个角色动作（如 `completed → [happy, spin]`，多个时随机播放）。

**③ 角色状态 Character States**（以「鼠标状态」为底层，决定何时播哪个动作）：

| 鼠标状态 | 含义 | 状态开始（多个=随机） | 状态末 |
|---|---|---|---|
| `default` | 默认（常驻） | `idle` | — |
| `click` | 单击 | `happy`（可多个 → 随机） | 返回 `idle` |
| `drag` | 拖动 | `walk` | 松开后 `idle` |
| `timeout` | 超时（合并一条规则） | 超时前 `idle` → 超时后 `sleep` | 唤醒回 `idle` |

同一个鼠标状态挂多个动作时随机播放（如单击随机播「开心 / 转圈」）。

## 快速开始

### 方式一：随 DeepSeek Harness 启动（推荐）

1. 安装插件到 dsh web profile：

```sh
cd <deepseek-pet>
bash scripts/install-harness-plugin.sh
```

脚本会把插件复制到 `~/.dsh/profiles/node_modules/dsh-pet-status/`、写进依赖清单、并在 `cordis.patch.yml` 里挂载并开启 `autoStart`。

2. 启动 harness（桌宠会自动拉起）：

```sh
cd ~/Projects/deepseek-harness
pnpm dsh web
```

停止 `dsh web`（Ctrl+C）时，桌宠随之一并关闭。

### 方式二：独立运行（仅桌宠，离线模式）

```sh
npm install
npm start
```

- 窗口出现在屏幕右下角，拖拽即可移动。
- 右键窗口 →「⚙️ 更改配置」打开配置页，「退出桌宠」关闭。
- 独立运行时不连接 harness，气泡显示「Offline」。

> 依赖 Electron（`npm install` 自动下载二进制）。中国大陆网络较慢时，先执行
> `export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` 加速下载。

## 配置管理（`/pet/settings`）

右键桌宠 →「⚙️ 更改配置」，或直接访问 `http://127.0.0.1:3080/pet/settings`。页面分四个板块：

- **任务状态**：气泡文字、颜色、完成后触发一个或多个角色动作（随机播放）；
- **角色状态**：以鼠标状态为底层（默认 / 点击 / 拖动 / 超时），「状态开始」可挂多个动作（随机播放）、「状态末」选返回动作、可调时长；
- **角色动作**：标签、帧目录、帧数、帧率，以及**删除动作**；
- **动作帧管理**：帧缩略图预览、上传替换帧、添加新动作、重启桌宠。

改动说明：

| 改了什么 | 生效方式 |
|---|---|
| 文字 / 颜色 / 触发点 / 帧 | 点「重启桌宠」 |
| 状态协议（插件与桌宠的 WebSocket） | 重启 `pnpm dsh web` |

## HTTP API 速览（由插件提供）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/pet.config` | 读配置 |
| `PUT` | `/api/pet.config` | 写配置 |
| `POST` | `/api/pet.frames` | 上传/替换动作帧（base64 JSON，校验 PNG + 尺寸上限 256px） |
| `DELETE` | `/api/pet.action` | 删除动作（连带删帧目录 + 引用安全回退） |
| `GET` | `/pet/frames/<folder>/<file>` | 帧图片预览 |
| `POST` | `/api/pet.restart` | 重启桌宠子进程 |
| `GET` | `/pet/settings` | 配置管理页 |

## 加 / 删动作

**加动作**：配置页「动作帧管理」→ 输入动作名 + 多选 PNG 帧 →「添加动作」；再到「角色状态」或「任务状态」里把它挂到某个触发点。

**删动作**：配置页「角色动作」表里点「删除」。会同时删除其帧目录，并把所有引用（默认待机/点击/拖动/超时）自动回退到 `idle`。

也可手动操作（动作帧目录约定为 `Deepseek/animations/<目录>/south/frame_NNN.png`，`NNN` 三位零填充）。

## 目录结构

```
harness-plugin/            # dsh-pet-status 插件（Cordis）
  src/index.ts             # 状态广播 + 桌宠管理器 + HTTP API
  settings.html            # 配置管理页（自包含）
  package.json
Deepseek/                  # 精灵素材（PixelLab 生成）
  rotations/               # 8 方向立绘
  animations/              # 动作帧序列（<目录>/south/frame_NNN.png）
pet.config.json            # 控制逻辑：状态/动作/触发（v3）
normalize-animations.mjs   # 素材标准化脚本（gif 拆帧 + 校验 + 报告帧数）
main.cjs / preload.cjs     # Electron 主进程 + 预加载（IPC 拖拽窗口 / 状态转发）
index.html / main.js       # 渲染层：透明画布 + 配置驱动的状态机
scripts/install-harness-plugin.sh  # 一键安装插件到 dsh web profile
```

## 素材声明

角色精灵素材（`Deepseek/` 下的像素图）由 [PixelLab](https://www.pixellab.ai/) 生成。素材版权与再分发条款请以 PixelLab 的授权说明为准。

## 路线图

- [x] 重构为 DeepSeek Harness 插件（随 `dsh web` 启动、纳入进程树管理）。
- [x] 与 agent 状态联动（任务进行/完成/截止切换气泡与动画）。
- [x] 可视化配置页（状态 / 角色状态 / 动作 / 帧管理，含上传与删除）。
- [ ] 点击穿透（透明区域不拦截鼠标）。
- [ ] 位置记忆、重力贴边、8 方向走路。
- [ ] 桌宠输入 → harness 的上行交互（当前仅 harness → 桌宠下行）。

## License

[MIT](./LICENSE) © 2026 BenjaminSHI4008
