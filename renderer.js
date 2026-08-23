// 渲染层：配置驱动的 2D 精灵（v3：statuses + actions + characterStates）
// 状态维度已拆分：
//   - 任务状态（statuses，来自 harness）：running/completed/terminated/offline → 决定气泡文字
//   - 角色动作（actions，桌宠动画）：idle/happy/walk/sleep → 决定精灵动画
//   - 角色状态（characterStates，鼠标状态驱动）：默认/点击/拖动/超时 → 决定何时播哪个动作
const canvas = document.getElementById('pet')
const ctx = canvas.getContext('2d')
const BASE_SCALE = 1.5
const BASE_SIZE = 240
const bubble = document.getElementById('bubble')

// 尽早注册状态监听（避免错过初始推送）；渲染延后到配置加载完成后
let latestStatus = 'offline'
let configLoaded = false
window.petAPI.onStatus((s) => { latestStatus = s; if (configLoaded) renderStatus() })
window.petAPI.onScale((s) => applyScale(s))

const config = await (await fetch('./pet.config.json')).json()
const DIR = config.direction
const ROOT = 'Deepseek'
const STATUSES = config.statuses
const CS = config.characterStates ?? {}
const STATUS_ACTION_MS = config.statusActionMs ?? 2000

// 桌宠整体缩放：画布尺寸 = 240 × scale，精灵缩放 = 1.5 × scale（scale 默认 1）
const winScale = typeof config.scale === 'number' && config.scale > 0 ? config.scale : 1
let SCALE = BASE_SCALE * winScale
let WIN_SIZE = Math.round(BASE_SIZE * winScale)
canvas.width = WIN_SIZE
canvas.height = WIN_SIZE
canvas.style.width = WIN_SIZE + 'px'
canvas.style.height = WIN_SIZE + 'px'
bubble.style.fontSize = Math.round(10 * winScale) + 'px'
const _shadow = Math.max(1, Math.round(2 * winScale))
bubble.style.textShadow = `${_shadow}px ${_shadow}px 0 #000`

// 构建动作：intro（入场帧，播一次）+ loop（循环帧）
function framePaths(folder, count) {
  return Array.from({ length: count }, (_, i) =>
    `${ROOT}/animations/${folder}/${DIR}/frame_${String(i).padStart(3, '0')}.png`,
  )
}
const ACTIONS = {}
for (const [name, a] of Object.entries(config.actions)) {
  const all = framePaths(a.folder, a.count)
  const introEnd = a.intro ? a.intro[1] : -1
  ACTIONS[name] = {
    label: a.label,
    fps: a.fps,
    intro: introEnd >= 0 ? all.slice(0, introEnd + 1) : [],
    loop: introEnd >= 0 ? all.slice(introEnd + 1) : all,
  }
}

// 预加载所有帧（缺失/损坏的帧跳过，不让单个坏图拖垮整个桌宠）
const cache = new Map()
async function loadFrame(path) {
  const img = new Image()
  img.src = './' + path
  try {
    await img.decode()
    cache.set(path, img)
  } catch {
    console.warn(`[pet] 帧加载失败，已跳过：${path}`)
  }
}
const allPaths = new Set()
for (const a of Object.values(ACTIONS)) for (const p of [...a.intro, ...a.loop]) allPaths.add(p)
await Promise.all([...allPaths].map(loadFrame))

// 过滤掉加载失败的帧；空动作直接禁用，避免空白桌宠「消失」
for (const [name, a] of Object.entries(ACTIONS)) {
  a.intro = a.intro.filter((p) => cache.has(p))
  a.loop = a.loop.filter((p) => cache.has(p))
  if (a.intro.length === 0 && a.loop.length === 0) {
    console.warn(`[pet] 动作 "${name}" 没有任何可用帧，已禁用`)
    delete ACTIONS[name]
  }
}
// 默认待机动作（characterStates.default.play[0]），不存在时回退到 idle / 任意可用动作
let defaultAction = (CS.default?.play?.[0]) ?? 'idle'
if (!ACTIONS[defaultAction]) {
  defaultAction = ACTIONS.idle ? 'idle' : Object.keys(ACTIONS)[0]
}
if (!defaultAction) {
  console.error('[pet] 没有任何可用精灵帧，请检查 Deepseek/animations/ 与 pet.config.json')
  bubble.textContent = 'No sprites'
  bubble.style.color = '#ff5252'
  bubble.className = 'show'
  throw new Error('no valid sprite frames')
}
const fallbackAction = (name) => (ACTIONS[name] ? name : defaultAction)

// 从一个「状态开始」动作池里随机选一个（过滤掉已删除的动作，空则回退默认）
function pickPlay(list) {
  const valid = (Array.isArray(list) ? list : []).filter((a) => ACTIONS[a])
  if (valid.length === 0) return defaultAction
  return valid[Math.floor(Math.random() * valid.length)]
}

// 拖拽方向 → 动作：根据鼠标移动方向实时切换，支持水平/垂直镜像
function classifyDirection(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}
function playDragDirection(dir) {
  const d = CS.drag?.directions?.[dir]
  if (!d || !Array.isArray(d.play) || d.play.length === 0) return // 未配置该方向：保持当前动作
  const action = pickPlay(d.play)
  setState(action, { flipX: d.flipX ?? false, flipY: d.flipY ?? false })
}
function updateDragDirection(x, y) {
  if (!dragDirOrigin) { dragDirOrigin = { x, y }; return }
  const dx = x - dragDirOrigin.x
  const dy = y - dragDirOrigin.y
  if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return // 位移阈值，避免方向抖动
  const dir = classifyDirection(dx, dy)
  if (dir !== lastDragDir) {
    lastDragDir = dir
    playDragDirection(dir)
  }
  dragDirOrigin = { x, y }
}

// ── 状态机（动作 = 角色动作，intro 播一次后进入 loop 循环）──────────
let state = defaultAction
let statusAction = null // 当前状态应持续播放的动作（running 时 = 工作动作）；交互结束后回到它
let phase = ACTIONS[state].intro.length > 0 ? 'intro' : 'loop'
let frameIdx = 0
let lastFrameTime = 0
let flipX = false // 当前动作水平镜像
let flipY = false // 当前动作垂直镜像
let dragDirOrigin = null // 拖拽方向判定的起点
let lastDragDir = null // 上一次判定的方向

const cur = () => ACTIONS[state]
const curFrames = () => (phase === 'intro' ? cur().intro : cur().loop)
const interval = () => 1000 / cur().fps

let sleepTimer = null
const cancelSleep = () => { if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null } }
let returnTimer = null
const cancelReturn = () => { if (returnTimer) { clearTimeout(returnTimer); returnTimer = null } }
let statusActionTimer = null
const cancelStatusAction = () => { if (statusActionTimer) { clearTimeout(statusActionTimer); statusActionTimer = null } }

function setState(s, opts = {}) {
  s = fallbackAction(s)
  state = s
  flipX = opts.flipX ?? false
  flipY = opts.flipY ?? false
  phase = ACTIONS[s].intro.length > 0 ? 'intro' : 'loop'
  frameIdx = 0
  lastFrameTime = performance.now()
  drawFrame(curFrames()[0])
  cancelSleep()
  cancelReturn()
  cancelStatusAction()
  if (s === CS.timeout.before) {
    sleepTimer = setTimeout(() => setState(CS.timeout.after), CS.timeout.afterMs)
  }
}

function drawFrame(path) {
  const img = cache.get(path)
  if (!img) return // 防御：缺帧时保持上一帧
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  const w = img.naturalWidth * SCALE
  const h = img.naturalHeight * SCALE
  const dx = (canvas.width - w) / 2
  const dy = (canvas.height - h) / 2
  ctx.save()
  if (flipX || flipY) {
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    ctx.translate(-canvas.width / 2, -canvas.height / 2)
  }
  ctx.drawImage(img, dx, dy, w, h)
  ctx.restore()
}

// 运行时调整大小（右键菜单）：重建画布缓冲/CSS 尺寸，并按当前帧重绘
function applyScale(s) {
  if (!configLoaded) return
  const ws = typeof s === 'number' && s > 0 ? s : 1
  SCALE = BASE_SCALE * ws
  WIN_SIZE = Math.round(BASE_SIZE * ws)
  canvas.width = WIN_SIZE
  canvas.height = WIN_SIZE
  canvas.style.width = WIN_SIZE + 'px'
  canvas.style.height = WIN_SIZE + 'px'
  bubble.style.fontSize = Math.round(10 * ws) + 'px'
  const sh = Math.max(1, Math.round(2 * ws))
  bubble.style.textShadow = `${sh}px ${sh}px 0 #000`
  if (ACTIONS[state]) drawFrame(curFrames()[frameIdx])
}

function tick(now) {
  requestAnimationFrame(tick)
  const frames = curFrames()
  if (now - lastFrameTime >= interval()) {
    lastFrameTime = now
    const next = frameIdx + 1
    if (next >= frames.length) {
      if (phase === 'intro') {
        phase = 'loop' // intro 播完 → 进入循环
        frameIdx = 0
      } else {
        frameIdx = 0 // 循环
      }
    } else {
      frameIdx = next
    }
    drawFrame(curFrames()[frameIdx])
  }
}

// ── 气泡渲染（从任务状态读文案/颜色）──────────────
let bubbleWasWorking = false
let bubbleTimer = null
let stateMachineReady = false
let pendingAction = null

function triggerStatusAction(actions) {
  const picked = pickPlay(actions) // 多个动作随机选一个
  if (!stateMachineReady) { pendingAction = picked; return }
  playAction(picked)
}
function playAction(action) {
  setState(action)
  // 状态触发动作至少播完整一轮（intro+loop），避免新动作帧多/帧率低时被固定 2s 截断。
  const a = ACTIONS[action]
  const frameCount = a ? (a.intro.length + a.loop.length) : 0
  const loopMs = a && a.fps > 0 ? Math.round((frameCount / a.fps) * 1000) : 0
  const dur = Math.max(STATUS_ACTION_MS, loopMs)
  statusActionTimer = setTimeout(() => { if (state === action) setState(defaultAction) }, dur)
}

function renderStatus() {
  // 归一化：兼容旧插件广播的 working/idle（避免插件与桌宠短暂版本错位时误显示 Offline）
  let status = latestStatus
  if (status === 'working') status = 'running'
  else if (status === 'idle') status = 'completed'
  const s = STATUSES[status] ?? STATUSES.offline
  clearTimeout(bubbleTimer)
  bubble.style.pointerEvents = 'none' // 默认气泡不可交互；仅「运行中」可右键打断
  statusAction = null // 默认清除；仅 running 分支会设置
  if (status === 'running') {
    // 任务进行：持续显示气泡（运行中可右键打断会话）+ 持续循环播放 running 动作（如「工作」）
    bubble.textContent = s.text
    bubble.style.color = s.color
    bubble.className = 'show'
    bubble.style.pointerEvents = 'auto'
    bubbleWasWorking = true
    if (Array.isArray(s.actions) && s.actions.length > 0) { statusAction = pickPlay(s.actions); setState(statusAction) }
  } else if (status === 'received') {
    // 收到发送：进入 running 前的短暂提示 + 播放「收到」动作（如 Get）。
    // 不改 bubbleWasWorking，让后续 Completed 正常闪烁。
    bubble.textContent = s.text
    bubble.style.color = s.color
    bubble.className = 'show'
    bubble.style.pointerEvents = 'none'
    if (Array.isArray(s.actions) && s.actions.length > 0) triggerStatusAction(s.actions)
  } else if (status === 'completed' || status === 'terminated') {
    // 任务结束：短暂闪一下结果气泡
    if (bubbleWasWorking) {
      bubble.textContent = s.text
      bubble.style.color = s.color
      bubble.className = 'show'
      bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 5000)
      if (Array.isArray(s.actions) && s.actions.length > 0) triggerStatusAction(s.actions) // 如 completed → [happy, ...] 随机
      else setState(defaultAction) // 无动作时回到默认，避免停留在 running 动作
    } else {
      bubble.className = ''
    }
    bubbleWasWorking = false
  } else {
    // offline
    bubble.textContent = s.text
    bubble.style.color = s.color
    bubble.className = 'show'
    bubbleWasWorking = false
  }
}

// ── 鼠标状态：拖动 / 点击（拖拽通过 IPC 移动窗口）──────────────
let dragging = false
let moved = false
let downState = null
let dragStart = { x: 0, y: 0 }

// 命中检测：只在角色非透明像素上响应点击/拖动，缩小「选定框」到角色本体
function hitTest(clientX, clientY) {
  const rect = canvas.getBoundingClientRect()
  const x = Math.floor((clientX - rect.left) * (canvas.width / rect.width))
  const y = Math.floor((clientY - rect.top) * (canvas.height / rect.height))
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false
  try {
    return ctx.getImageData(x, y, 1, 1).data[3] > 16
  } catch {
    return true // 读取失败放行，避免无法交互
  }
}

// 双击检测：单一职责——区分「双击」与「单击」。
// 不延迟单击（首次点击的单击动作照常即时播放），仅识别 300ms 内的第二次点击。
class DoubleClickDetector {
  constructor(timeout = 300) {
    this.timeout = timeout
    this.lastClickAt = 0
  }
  // 返回 true 表示本次点击是「双击中的第二次」，调用方据此抑制单击动作
  isDoubleClick(now = performance.now()) {
    const isDouble = now - this.lastClickAt < this.timeout
    this.lastClickAt = now
    return isDouble
  }
}
const doubleClick = new DoubleClickDetector()

canvas.addEventListener('mousedown', (e) => {
  if (!hitTest(e.clientX, e.clientY)) return // 透明区域不响应，只在角色像素上触发
  dragging = true
  moved = false
  downState = state
  dragStart = { x: e.screenX, y: e.screenY }
  dragDirOrigin = null
  lastDragDir = null
  window.petAPI.dragStart(e.screenX, e.screenY)
  if (state === CS.timeout.after) setState(CS.timeout.before) // 睡觉中按下 → 唤醒
})
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  if (!moved && Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) > 4) {
    moved = true
    dragDirOrigin = { x: dragStart.x, y: dragStart.y }
    lastDragDir = null
  }
  if (moved) {
    window.petAPI.dragMove(e.screenX, e.screenY)
    updateDragDirection(e.screenX, e.screenY) // 根据移动方向实时切换动作
  }
})
window.addEventListener('mouseup', () => {
  if (dragging && moved) {
    setState(statusAction || CS.drag.returnTo) // 松开 → running 时回「工作」，否则回状态末
  } else if (dragging && !moved) {
    if (doubleClick.isDoubleClick()) {
      window.petAPI.toggleChat() // 双击 → 呼出/收回聊天框
    } else if (downState === state && (state === defaultAction || state === statusAction)) {
      // 单击（待机或 running 时）→ 随机播放点击动作，片刻后回到 home（工作 / 待机）
      const action = pickPlay(CS.click.play)
      setState(action)
      returnTimer = setTimeout(() => { if (state === action) setState(statusAction || CS.click.returnTo) }, CS.click.afterMs ?? 2000)
    }
  }
  dragging = false
})

// 指针样式跟随命中范围：仅悬停在角色像素上显示「抓手」，拖动中显示「抓取中」
canvas.addEventListener('mousemove', (e) => {
  canvas.style.cursor = dragging ? 'grabbing' : (hitTest(e.clientX, e.clientY) ? 'grab' : 'default')
})

// 气泡右键打断：仅「运行中（Deep diving）」气泡可交互，右键 → 打断当前会话（与桌宠右键菜单隔开）
bubble.addEventListener('contextmenu', (e) => {
  if (latestStatus !== 'running') return
  e.preventDefault()
  e.stopPropagation()
  if (window.confirm('打断当前会话？')) window.petAPI.cancelChat()
})

// ── 就绪 ──────────────
latestStatus = await window.petAPI.getStatus() // 同步主进程当前状态（兜底）
configLoaded = true
renderStatus()
stateMachineReady = true
setState(defaultAction)
if (pendingAction) {
  const a = pendingAction
  pendingAction = null
  playAction(a) // 启动时就已完成的任务：补一次随机动作
}
requestAnimationFrame(tick)
