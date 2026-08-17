// Electron 主进程：透明、无边框、置顶的桌宠窗口
const { app, BrowserWindow, Menu, screen, ipcMain } = require('electron')
const path = require('path')

const WIN_SIZE = 240

// 拖拽窗口：记录起点，随鼠标移动窗口
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

  // 右键退出（无边框窗口没有关闭按钮）
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([{ label: '退出桌宠', click: () => app.quit() }]).popup({ window: win })
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
