// 聊天窗口管理：单一职责——聊天框窗口的创建 / 显示 / 关闭 / 推送。
// 桌宠主窗口仍是 240×240 透明精灵，聊天框是独立窗口，二者互不影响。
const { BrowserWindow, screen } = require('electron')
const path = require('path')

class ChatWindow {
  constructor({ width = 360, height = 480 } = {}) {
    this.width = width
    this.height = height
    this.win = null
  }

  // 打开（已存在则聚焦），anchor 为桌宠窗口位置 [x, y]，聊天框贴近桌宠
  show(anchor) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      this.win.focus()
      return
    }
    this.win = new BrowserWindow({
      width: this.width,
      height: this.height,
      frame: false, // 像素风无边框，自绘标题栏
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'chat-preload.cjs'),
        webSecurity: false,
      },
    })
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.positionNear(anchor)
    this.win.loadFile('chat.html')
    this.win.on('closed', () => { this.win = null })
  }

  positionNear(anchor) {
    const { workAreaSize } = screen.getPrimaryDisplay()
    const ax = anchor ? anchor[0] : workAreaSize.width - this.width - 40
    const ay = anchor ? anchor[1] : workAreaSize.height - this.height - 40
    const x = Math.min(Math.max(ax, 0), workAreaSize.width - this.width)
    const y = Math.min(Math.max(ay - this.height - 8, 0), workAreaSize.height - this.height)
    this.win.setPosition(Math.round(x), Math.round(y))
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close()
  }

  // 向聊天框渲染层推送事件（P2：流式回复 / 状态）
  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }
}

module.exports = { ChatWindow }
