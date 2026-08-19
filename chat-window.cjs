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
      transparent: true, // 透明背景，让圆角气泡 + 尖角正确显示
      hasShadow: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'chat-preload.cjs'),
        webSecurity: false,
      },
    })
    // floating 级别：置顶但不压过系统输入法候选条（screen-saver 会盖住候选条导致打字看不到）
    this.win.setAlwaysOnTop(true, 'floating')
    this.positionNear(anchor)
    this.win.loadFile('chat.html')
    this.win.on('closed', () => { this.win = null })
  }

  positionNear(anchor) {
    const { workAreaSize } = screen.getPrimaryDisplay()
    const MIN_BOTTOM_SPACE = 240 // 输入框下方给系统输入法候选条留的空间
    const ax = anchor ? anchor[0] : workAreaSize.width - this.width - 40
    const ay = anchor ? anchor[1] : workAreaSize.height - this.height - 40
    const x = Math.min(Math.max(ax, 0), workAreaSize.width - this.width)
    // 优先放桌宠上方；若输入框会太靠屏幕底部（遮挡候选条），则整体上移
    let y = ay - this.height - 12
    const maxY = workAreaSize.height - this.height - MIN_BOTTOM_SPACE
    if (y > maxY) y = maxY
    y = Math.max(y, 0)
    this.win.setPosition(Math.round(x), Math.round(y))
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close()
  }

  // 收起（输入后转由桌宠显示 Deep diving，聊天框隐藏但继续接收流式输出）
  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  // 展开（会话完成时重新显示，展示输出内容，不重新定位）
  reveal() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      this.win.focus()
    }
  }

  // 向聊天框渲染层推送事件（P2：流式回复 / 状态）
  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }
}

module.exports = { ChatWindow }
