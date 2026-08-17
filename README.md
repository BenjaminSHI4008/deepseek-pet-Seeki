# DeepSeek Pet

> 一个基于 DeepSeek Harness 的**桌面宠物（桌宠）插件**：在桌面任意位置悬浮一只透明的像素风角色，可拖拽、可互动、自动切换待机/走路/开心/睡觉等状态。

## 项目定位

本项目定位为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个 Plugin（社区项目，非官方）。

当前 `v0.1` 为**独立可运行的 Electron 应用**（透明置顶窗口 + 2D 精灵状态机），用于验证「系统级桌宠」的核心能力；后续将重构为随 DeepSeek Harness 启动、与 agent 状态联动的正式插件。

## 特性

- **透明、无边框、置顶**的桌面窗口（`transparent` + `frame:false` + `alwaysOnTop`）。
- **2D 精灵状态机**：待机（呼吸）/ 走路 / 开心 / 打哈欠→睡觉，帧动画循环。
- **交互**：拖拽移动（走路）、单击（唤醒 / 开心）、超时自动睡觉。
- **配置驱动**：所有动画、帧率、状态与触发规则都声明在 `pet.config.json`，加新动作无需改渲染代码。

## 快速开始

```sh
npm install
npm start
```

- 窗口出现在屏幕右下角，拖拽即可移动。
- 右键窗口 → 「退出桌宠」，或 `Cmd + Q`。

> 依赖 Electron（`npm install` 会自动下载二进制）。在中国大陆网络较慢时，可先执行
> `export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` 加速下载。

## 目录结构

```
Deepseek/                 # 精灵素材（由 PixelLab 生成）
  rotations/              # 8 方向立绘
  animations/             # 动作帧序列（<动作名>/south/frame_NNN.png）
pet.config.json           # 控制逻辑：动画/帧率/状态/触发（改这里即可加新动作）
normalize-animations.mjs  # 素材标准化脚本（gif 拆帧 + 校验 + 报告帧数）
main.cjs / preload.cjs    # Electron 主进程 + 预加载（IPC 拖拽窗口）
index.html / main.js      # 渲染层：透明画布 + 配置驱动的状态机
```

## 加一个新动作

1. 把帧序列放进 `Deepseek/animations/<动作名>/south/frame_000.png …`（若是 gif，先跑 `node normalize-animations.mjs`）。
2. 在 `pet.config.json` 的 `animations` 加一条 `{ "fps": 6, "count": 6 }`，在 `states` 加一个状态，`triggers.buttons` 里加一个按钮。

详见 `pet.config.json` 内的字段注释与 `README` 中的约定。

## 素材声明

角色精灵素材（`Deepseek/` 下的像素图）由 [PixelLab](https://www.pixellab.ai/) 生成。素材版权与再分发条款请以 PixelLab 的授权说明为准。

## 路线图

- [ ] 重构为 DeepSeek Harness 插件（随 `dsh` 启动，纳入进程树管理）。
- [ ] 点击穿透（透明区域不拦截鼠标）。
- [ ] 位置记忆、重力贴边、8 方向走路。
- [ ] 与 agent 状态联动（思考中 / 工作中 / 空闲切换动画）。

## License

[MIT](./LICENSE) © 2026 BenjaminSHI4008
