# 配置参考（pet.config.json）

桌宠的全部行为都由 `pet.config.json` 驱动，无需改代码即可定制气泡文案、动画与触发规则。改完后在配置页点「保存」并「重启桌宠」生效。

## 版本与顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | 配置格式版本，当前 `3` |
| `character` | string | 角色名，对应素材目录 `Deepseek/` 下（预留） |
| `direction` | string | 帧方向目录名，当前固定 `south` |
| `server.wsUrl` | string | 独立运行（不连 harness）时兜底连接的 WebSocket 地址 |
| `statuses` | object | 任务状态 → 气泡文案/颜色/触发动作（见下） |
| `actions` | object | 角色动作（动画帧序列）定义（见下） |
| `statusActionMs` | number | 任务状态触发的动作播放时长（毫秒），默认 2000 |
| `characterStates` | object | 角色状态（鼠标状态驱动），见下 |

## ① statuses — 任务状态

来自 harness 的任务状态，决定头顶气泡。键固定为 `running / completed / terminated / offline`：

```jsonc
"statuses": {
  "running":    { "text": "Deep diving...", "color": "#4fc3f7", "actions": [] },
  "completed":  { "text": "Completed",      "color": "#7ed957", "actions": ["happy"] },
  "terminated": { "text": "Stopped",        "color": "#ff5252", "actions": [] },
  "offline":    { "text": "Offline",        "color": "#9e9e9e", "actions": [] }
}
```

| 字段 | 说明 |
|---|---|
| `text` | 气泡文字 |
| `color` | 气泡颜色（CSS 颜色值） |
| `actions` | 该状态触发的角色动作数组；**多个时随机播放**，空数组 = 不触发 |

## ② actions — 角色动作

桌宠的动画帧序列，键为动作 id（被 statuses/characterStates 引用）：

```jsonc
"actions": {
  "idle":  { "label": "待机", "fps": 4,   "folder": "Breathing_Idle",          "count": 4 },
  "walk":  { "label": "拖动", "fps": 8,   "folder": "Crouched_Walking",         "count": 6 },
  "sleep": { "label": "睡觉", "fps": 2.5, "folder": "Close_eyes_and_sleeping",  "count": 9, "intro": [0, 2] }
}
```

| 字段 | 说明 |
|---|---|
| `label` | 显示名（配置页下拉里展示） |
| `fps` | 帧率（每秒帧数） |
| `folder` | 帧目录名，对应 `Deepseek/animations/<folder>/south/` |
| `count` | 帧数（从 `frame_000.png` 起连续） |
| `intro` | 可选 `[起始帧, 结束帧]`：入场帧播一次后进入循环，其余帧循环播放 |

帧文件约定：`Deepseek/animations/<folder>/<direction>/frame_NNN.png`，`NNN` 三位零填充。

## ③ characterStates — 角色状态（鼠标状态驱动）

### default — 默认待机

```jsonc
"default": { "play": ["idle"] }
```

`play` 为数组，取第一个作为常驻动作。

### click — 单击

```jsonc
"click": { "play": ["happy"], "returnTo": "idle", "afterMs": 2000 }
```

- `play`：点击时播放的动作数组（多个随机）；
- `returnTo`：播放结束后返回的动作；
- `afterMs`：播放时长（毫秒）。

### drag — 拖动（按方向）

```jsonc
"drag": {
  "directions": {
    "left":  { "play": ["walk"] },
    "right": { "play": ["walk"], "flipX": true },
    "up":    { "play": [] },
    "down":  { "play": [] }
  },
  "returnTo": "idle"
}
```

- `directions.left/right/up/down`：每个方向映射的 `play` 数组（多个随机；空 = 该方向不切换，保持当前动作）；
- `flipX` / `flipY`：可选，水平/垂直镜像（如 `right` 默认 `flipX: true`，用镜像复用朝左的走路帧得到朝右效果）；
- `returnTo`：松开后返回的动作。

拖拽时按位移主方向（左/右/上/下）实时切换对应动作。

### timeout — 超时（一条规则）

```jsonc
"timeout": { "before": "idle", "after": "sleep", "afterMs": 12000 }
```

- `before`：超时前停留的动作（在此状态停留触发计时）；
- `after`：超时后进入的动作；
- `afterMs`：空闲多久超时（毫秒）。

## 完整示例

见仓库根目录的 [`pet.config.json`](../pet.config.json)。
