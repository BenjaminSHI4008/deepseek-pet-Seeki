// 渲染层：配置驱动的 2D 精灵状态机（完整版：点击唤醒/开心、拖拽走路、超时睡觉）
const canvas = document.getElementById('pet')
const ctx = canvas.getContext('2d')
const SCALE = 1.5

// 头顶状态气泡（两态：Deep diving... / 已完成），尽早注册监听避免错过初始推送
const bubble = document.getElementById('bubble')
let bubbleWasWorking = false
let bubbleTimer = null
let stateMachineReady = false
let pendingCelebrate = false

// 任务完成 → 开心动作（2 秒后回待机）。状态机就绪前先记下，就绪后补触发。
function celebrate() {
  if (!stateMachineReady) {
    pendingCelebrate = true
    return
  }
  setState('happy')
  returnTimer = setTimeout(() => { if (state === 'happy') setState('idle') }, 2000)
}

function updateBubble(status) {
  clearTimeout(bubbleTimer)
  if (status === 'working') {
    bubble.className = 'st-working show'
    bubble.textContent = 'Deep diving...'
    bubbleWasWorking = true
  } else if (status === 'idle') {
    if (bubbleWasWorking) {
      // 工作 → 完成：显示「已完成」+ 同步切开心动作
      bubble.className = 'st-done show'
      bubble.textContent = '已完成'
      bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 5000)
      celebrate()
    } else {
      bubble.className = ''
    }
    bubbleWasWorking = false
  } else {
    // offline
    bubble.className = 'st-offline show'
    bubble.textContent = '📡 离线'
    bubbleWasWorking = false
  }
}
window.petAPI.onStatus(updateBubble)

const config = await (await fetch('./pet.config.json')).json()
const DIR = config.direction
const ROOT = 'Deepseek'

function buildFrames(anim, count) {
  return Array.from({ length: count }, (_, i) =>
    `${ROOT}/animations/${anim}/${DIR}/frame_${String(i).padStart(3, '0')}.png`,
  )
}
const STATES = {}
for (const [name, s] of Object.entries(config.states)) {
  const anim = config.animations[s.anim]
  if (!anim) throw new Error(`state "${name}" 引用了未声明的动画 "${s.anim}"`)
  const all = buildFrames(s.anim, anim.count)
  const [from, to] = s.range ?? [0, anim.count - 1]
  STATES[name] = {
    label: s.label,
    fps: anim.fps,
    frames: all.slice(from, to + 1),
    loop: !s.next,
    next: s.next ?? null,
  }
}
const T = config.triggers

const cache = new Map()
async function loadFrame(path) {
  const img = new Image()
  img.src = './' + path
  await img.decode()
  cache.set(path, img)
}
const allPaths = new Set()
for (const st of Object.values(STATES)) for (const p of st.frames) allPaths.add(p)
await Promise.all([...allPaths].map(loadFrame))

let state = config.defaultState
let frameIdx = 0
let lastFrameTime = 0
let sleepDeadline = 0

const cur = () => STATES[state]
const interval = () => 1000 / cur().fps

let sleepTimer = null
const cancelSleep = () => { if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null } }
let returnTimer = null
const cancelReturn = () => { if (returnTimer) { clearTimeout(returnTimer); returnTimer = null } }

function setState(s) {
  state = s
  frameIdx = 0
  lastFrameTime = performance.now()
  drawFrame(cur().frames[0])
  cancelSleep()
  cancelReturn()
  if (s === T.timeout.from) {
    sleepDeadline = performance.now() + T.timeout.afterMs
    sleepTimer = setTimeout(() => setState(T.timeout.to), T.timeout.afterMs)
  }
}
function onStateEnd() { if (cur().next) setState(cur().next) }

function drawFrame(path) {
  const img = cache.get(path)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  const dx = (canvas.width - img.naturalWidth * SCALE) / 2
  const dy = (canvas.height - img.naturalHeight * SCALE) / 2
  ctx.drawImage(img, dx, dy, img.naturalWidth * SCALE, img.naturalHeight * SCALE)
}

function tick(now) {
  requestAnimationFrame(tick)
  const st = cur()
  if (now - lastFrameTime >= interval()) {
    lastFrameTime = now
    const next = frameIdx + 1
    if (next >= st.frames.length) {
      if (st.loop) frameIdx = 0
      else { onStateEnd(); return }
    } else {
      frameIdx = next
    }
    drawFrame(st.frames[frameIdx])
  }
}

// 拖拽 / 点击（拖拽通过 IPC 移动窗口；点击用于状态切换）
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
    setState(T.drag.during) // 拖动 → 走路
  }
  if (moved) window.petAPI.dragMove(e.screenX, e.screenY)
})
window.addEventListener('mouseup', () => {
  if (dragging && moved) setState(T.drag.after) // 松手 → 待机
  else if (dragging && !moved && downState === T.timeout.from && state === T.timeout.from) {
    // 单击待机 → 开心，片刻后回待机
    setState(T.clickIdle.to)
    returnTimer = setTimeout(() => { if (state === T.clickIdle.to) setState(T.clickIdle.returnTo) }, T.clickIdle.afterMs)
  }
  dragging = false
})

// 就绪后主动拉取一次当前状态（兜底：即使错过了初始推送也能同步）
updateBubble(await window.petAPI.getStatus())

stateMachineReady = true
setState(config.defaultState)
if (pendingCelebrate) {
  pendingCelebrate = false
  celebrate() // 启动时就已完成的任务：补一次开心
}
requestAnimationFrame(tick)
