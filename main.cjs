// Electron 主进程：透明、无边框、置顶的桌宠窗口 + 连接 harness 状态流
const { app, BrowserWindow, Menu, screen, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const WebSocket = require('ws')
const { ChatWindow } = require('./chat-window.cjs')

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

// 聊天窗口（双击桌宠打开）
const chatWindow = new ChatWindow()

// ── 聊天工作区（会话记录存放的文件夹）───────────────────────────────
const chatConfigPath = path.join(app.getPath('userData'), 'chat.config.json')
let chatConfig = {}
try {
  chatConfig = JSON.parse(fs.readFileSync(chatConfigPath, 'utf8'))
} catch {
  // 首次运行，无配置
}
function saveChatConfig() {
  fs.mkdirSync(path.dirname(chatConfigPath), { recursive: true })
  fs.writeFileSync(chatConfigPath, JSON.stringify(chatConfig, null, 2))
}
// 确保工作区已选：未选则弹文件夹选择（默认 ~/deepseek-pet，可新建/自选），取消返回 null
function ensureWorkspace() {
  if (chatConfig.workspacePath) return chatConfig.workspacePath
  const result = dialog.showOpenDialogSync({
    title: '选择桌宠对话工作区（存放聊天记录）',
    defaultPath: path.join(os.homedir(), 'deepseek-pet'),
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (!result || result.length === 0) return null
  const dir = result[0]
  fs.mkdirSync(dir, { recursive: true })
  chatConfig.workspacePath = dir
  saveChatConfig()
  return dir
}

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

// ── 聊天框 ───────────────────────────────────────────────────────────
ipcMain.handle('pet-open-chat', () => {
  if (!ensureWorkspace()) return // 用户取消选择工作区，则不打开聊天框
  const pos = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getPosition() : null
  chatWindow.show(pos)
})
ipcMain.on('chat-close', () => chatWindow.close())
ipcMain.on('chat-send', (_e, text) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text, workspacePath: chatConfig.workspacePath }))
  }
  chatWindow.hide() // 输入后收起聊天框，转由桌宠气泡显示 Deep diving
})
ipcMain.on('chat-new', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat-new' }))
  }
})
ipcMain.on('chat-cancel', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat-cancel' }))
  }
})
// 气泡随内容自适应尺寸（renderer 上报内容高度）
ipcMain.on('chat-resize', (_e, height) => chatWindow.resize(height))
// 气泡右键打断（与桌宠右键菜单「更改配置/退出」隔开）
ipcMain.on('pet-cancel-chat', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat-cancel' }))
  }
})
// 打开 harness web 端查看完整会话记录
const WEB_BASE_URL = WS_URL.replace(/^ws/, 'http').replace(/\/api\/pet\.ws$/, '')
ipcMain.on('chat-open-web', () => shell.openExternal(WEB_BASE_URL))

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
      else if (msg.type === 'chat-done') {
        chatWindow.reveal() // 会话完成 → 展开聊天框展示输出
        chatWindow.send('chat-event', msg)
      } else if (msg.type && msg.type.startsWith('chat-')) {
        chatWindow.send('chat-event', msg)
      }
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
  if (chatWindow.isOpen) chatWindow.follow(win.getPosition()) // 聊天气泡跟随桌宠移动
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
  chatWindow.close()
})
