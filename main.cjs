// Electron 主进程：透明、无边框、置顶的桌宠窗口 + 连接 harness 状态流
const { app, BrowserWindow, Menu, screen, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const WebSocket = require('ws')

const WIN_SIZE = 240

// 读取 pet.config.json（主进程用 fs 直接读，拿到 harness 的 WebSocket 地址）
let petConfig = {}
try {
  petConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'pet.config.json'), 'utf8'))
} catch (error) {
  console.error('读取 pet.config.json 失败：', error)
}
// 优先用 harness 插件通过环境变量传入的地址（端口随 harness 实际绑定端口变化）
const WS_URL = process.env.PET_WS_URL ?? petConfig.server?.wsUrl ?? 'ws://127.0.0.1:3080/api/pet.ws'
// 配置页地址：由 WS 地址推导（ws://host:port/api/pet.ws → http://host:port/pet/settings）
const SETTINGS_URL = WS_URL.replace(/^ws/, 'http').replace(/\/api\/pet\.ws$/, '') + '/pet/settings'

// ── 连接 harness 状态流 ────────────────────────────────────────────────
let mainWindow = null
let ws = null
let reconnectTimer = null
let reconnectDelay = 1000
let latestStatus = 'offline' // 记录最新状态，供渲染层就绪后主动拉取

function pushStatus(status) {
  latestStatus = status
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-status', status)
  }
}

// 渲染层就绪后主动拉取当前状态，避免错过初始推送（竞态）。
ipcMain.handle('pet-get-status', () => latestStatus)

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  ws = new WebSocket(WS_URL)

  ws.on('open', () => {
    reconnectDelay = 1000
  })
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'status') pushStatus(msg.status)
    } catch {
      // 非 JSON 消息忽略
    }
  })
  ws.on('close', () => {
    pushStatus('offline')
    scheduleReconnect()
  })
  ws.on('error', () => {
    pushStatus('offline')
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 15000) // 指数退避，上限 15s
    connect()
  }, reconnectDelay)
}

// ── 拖拽窗口 ───────────────────────────────────────────────────────────
let dragStartWin = null
let dragStartScreen = null
ipcMain.on('pet-drag-start', (e, { sx, sy }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  dragStartWin = win.getPosition()
  dragStartScreen = { sx, sy }
})
ipcMain.on('pet-drag-move', (e, { sx, sy }) => {
  if (!dragStartWin || !dragStartScreen) return
  const win = BrowserWindow.fromWebContents(e.sender)
  win.setPosition(
    Math.round(dragStartWin[0] + (sx - dragStartScreen.sx)),
    Math.round(dragStartWin[1] + (sy - dragStartScreen.sy)),
  )
})

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // demo-only：允许 file:// 下 fetch 本地 pet.config.json；正式版改用打包
      webSecurity: false,
      contextIsolation: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setPosition(workAreaSize.width - WIN_SIZE - 40, workAreaSize.height - WIN_SIZE - 40)
  win.loadFile('index.html')

  // 右键菜单：更改配置 / 退出（无边框窗口没有关闭按钮）
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '⚙️ 更改配置', click: () => shell.openExternal(SETTINGS_URL) },
      { type: 'separator' },
      { label: '退出桌宠', click: () => app.quit() },
    ]).popup({ window: win })
  })

  mainWindow = win
  connect() // 窗口就绪后连 harness
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) ws.terminate()
})
