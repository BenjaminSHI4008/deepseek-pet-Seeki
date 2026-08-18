// 渲染层：配置驱动的 2D 精灵（v2：statuses + actions + triggers）
// 状态维度已拆分：
//   - 任务状态（statuses，来自 harness）：running/completed/terminated/offline → 决定气泡文字
//   - 角色动作（actions，桌宠动画）：idle/happy/walk/sleep → 决定精灵动画
const canvas = document.getElementById('pet')
const ctx = canvas.getContext('2d')
const SCALE = 1.5
const bubble = document.getElementById('bubble')

// 尽早注册状态监听（避免错过初始推送）；渲染延后到配置加载完成后
let latestStatus = 'offline'
let configLoaded = false
window.petAPI.onStatus((s) => { latestStatus = s; if (configLoaded) renderStatus() })

const config = await (await fetch('./pet.config.json')).json()
const DIR = config.direction
const ROOT = 'Deepseek'
const STATUSES = config.statuses
const T = config.triggers

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
// 兜底：defaultAction 不存在时回退到 idle / 任意可用动作
if (!ACTIONS[config.defaultAction]) {
  config.defaultAction = ACTIONS.idle ? 'idle' : Object.keys(ACTIONS)[0]
}
if (!config.defaultAction) {
  console.error('[pet] 没有任何可用精灵帧，请检查 Deepseek/animations/ 与 pet.config.json')
  bubble.textContent = 'No sprites'
  bubble.style.color = '#ff5252'
  bubble.className = 'show'
  throw new Error('no valid sprite frames')
}
const fallbackAction = (name) => (ACTIONS[name] ? name : config.defaultAction)

// ── 状态机（动作 = 角色状态，intro 播一次后进入 loop 循环）──────────
let state = config.defaultAction
let phase = ACTIONS[state].intro.length > 0 ? 'intro' : 'loop'
let frameIdx = 0
let lastFrameTime = 0
let sleepDeadline = 0

const cur = () => ACTIONS[state]
const curFrames = () => (phase === 'intro' ? cur().intro : cur().loop)
const interval = () => 1000 / cur().fps

let sleepTimer = null
const cancelSleep = () => { if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null } }
let returnTimer = null
const cancelReturn = () => { if (returnTimer) { clearTimeout(returnTimer); returnTimer = null } }
let statusActionTimer = null
const cancelStatusAction = () => { if (statusActionTimer) { clearTimeout(statusActionTimer); statusActionTimer = null } }

function setState(s) {
  s = fallbackAction(s)
  state = s
  phase = ACTIONS[s].intro.length > 0 ? 'intro' : 'loop'
  frameIdx = 0
  lastFrameTime = performance.now()
  drawFrame(curFrames()[0])
  cancelSleep()
  cancelReturn()
  cancelStatusAction()
  if (s === T.timeout.from) {
    sleepDeadline = performance.now() + T.timeout.afterMs
    sleepTimer = setTimeout(() => setState(T.timeout.to), T.timeout.afterMs)
  }
}

function drawFrame(path) {
  const img = cache.get(path)
  if (!img) return // 防御：缺帧时保持上一帧
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  const dx = (canvas.width - img.naturalWidth * SCALE) / 2
  const dy = (canvas.height - img.naturalHeight * SCALE) / 2
  ctx.drawImage(img, dx, dy, img.naturalWidth * SCALE, img.naturalHeight * SCALE)
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

function triggerStatusAction(action) {
  if (!stateMachineReady) { pendingAction = action; return }
  setState(action)
  statusActionTimer = setTimeout(() => { if (state === action) setState(config.defaultAction) }, T.statusActionMs ?? 2000)
}

function renderStatus() {
  // 归一化：兼容旧插件广播的 working/idle（避免插件与桌宠短暂版本错位时误显示 Offline）
  let status = latestStatus
  if (status === 'working') status = 'running'
  else if (status === 'idle') status = 'completed'
  const s = STATUSES[status] ?? STATUSES.offline
  clearTimeout(bubbleTimer)
  if (status === 'running') {
    // 任务进行：持续显示气泡
    bubble.textContent = s.text
    bubble.style.color = s.color
    bubble.className = 'show'
    bubbleWasWorking = true
  } else if (status === 'completed' || status === 'terminated') {
    // 任务结束：短暂闪一下结果气泡
    if (bubbleWasWorking) {
      bubble.textContent = s.text
      bubble.style.color = s.color
      bubble.className = 'show'
      bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 5000)
      if (s.action) triggerStatusAction(s.action) // 如 completed → happy
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

// ── 拖拽 / 点击（拖拽通过 IPC 移动窗口；点击用于状态切换）──────────────
let dragging = false
let moved = false
let downState = null
let dragStart = { x: 0, y: 0 }

canvas.addEventListener('mousedown', (e) => {
  dragging = true
  moved = false
  downState = state
  dragStart = { x: e.screenX, y: e.screenY }
  window.petAPI.dragStart(e.screenX, e.screenY)
  if (T.wake.from.includes(state)) setState(T.wake.to) // 按下即唤醒
})
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  if (!moved && Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) > 4) {
    moved = true
    setState(T.drag.during) // 角色拖动 → 走路
  }
  if (moved) window.petAPI.dragMove(e.screenX, e.screenY)
})
window.addEventListener('mouseup', () => {
  if (dragging && moved) setState(T.drag.after) // 松手 → 角色待机
  else if (dragging && !moved && downState === T.timeout.from && state === T.timeout.from) {
    // 角色点击（待机时单击）→ 开心，片刻后回待机
    setState(T.clickIdle.to)
    returnTimer = setTimeout(() => { if (state === T.clickIdle.to) setState(T.clickIdle.returnTo) }, T.clickIdle.afterMs)
  }
  dragging = false
})

// ── 就绪 ──────────────
latestStatus = await window.petAPI.getStatus() // 同步主进程当前状态（兜底）
configLoaded = true
renderStatus()
stateMachineReady = true
setState(config.defaultAction)
if (pendingAction) {
  const a = pendingAction
  pendingAction = null
  triggerStatusAction(a) // 启动时就已完成的任务：补一次开心
}
requestAnimationFrame(tick)
