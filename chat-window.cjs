// 聊天窗口管理：单一职责——聊天气泡窗口的创建 / 显示 / 尺寸自适应 / 跟随桌宠 / 关闭。
// 气泡始终锚定在桌宠头顶上方，随内容自动伸缩，随桌宠移动而跟随。
const { BrowserWindow, screen } = require('electron')
const path = require('path')

const WIDTH = 300 // 气泡固定宽度
const MIN_HEIGHT = 140 // 小气泡
const MAX_HEIGHT = 440 // 大气泡（含尖角空间）
const TAIL_SPACE = 16 // 底部尖角留白（chat.html body 的 padding-bottom）
const HEAD_OFFSET = 22 // 桌宠头顶相对窗口顶部的近似偏移（精灵居中，头顶低于窗口顶部）
const GAP = 3 // 气泡尖角到头顶的呼吸空间（小间距，不贴住）

class ChatWindow {
  constructor() {
    this.win = null
    this.anchor = null // 桌宠窗口位置 [x, y]
  }

  get isOpen() {
    return !!this.win && !this.win.isDestroyed()
  }

  get isVisible() {
    return this.isOpen && this.win.isVisible()
  }

  // 打开（已存在则聚焦）。anchor 为桌宠窗口位置 [x, y]
  show(anchor) {
    if (this.isOpen) {
      this.anchor = anchor
      this.win.show()
      this.win.focus()
      return
    }
    this.anchor = anchor
    this.win = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false, // 由内容自适应，禁止手动拉伸
      alwaysOnTop: false, // 普通层级，避免压住系统输入法候选条（打字可见）
      skipTaskbar: true, // 轻量气泡，不占任务栏
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'chat-preload.cjs'),
        webSecurity: false,
      },
    })
    this.win.loadFile('chat.html')
    this.win.on('closed', () => { this.win = null })
    this.anchorToPet()
  }

  // 气泡底部（尖角）锚定在桌宠头顶上方，水平居中于桌宠
  anchorToPet() {
    if (!this.isOpen) return
    const [w, h] = this.win.getSize()
    const { workAreaSize } = screen.getPrimaryDisplay()
    const petX = this.anchor ? this.anchor[0] : workAreaSize.width - 240 - 40
    const petY = this.anchor ? this.anchor[1] : workAreaSize.height - 240 - 40
    const x = Math.round(Math.min(Math.max(petX + 120 - w / 2, 0), workAreaSize.width - w))
    // 锚定到桌宠头顶（petY + HEAD_OFFSET）而非窗口顶部，缩短视觉间距
    const headY = petY + HEAD_OFFSET
    const y = Math.round(Math.min(Math.max(headY - h - GAP, 0), workAreaSize.height - h))
    this.win.setPosition(x, y)
  }

  // 根据内容高度自适应窗口：气泡从桌宠头顶向上生长，底部保持锚定
  resize(contentHeight) {
    if (!this.isOpen) return
    const h = Math.round(Math.min(Math.max(contentHeight + TAIL_SPACE, MIN_HEIGHT), MAX_HEIGHT))
    const [, oldH] = this.win.getSize()
    if (h === oldH) return
    this.win.setSize(WIDTH, h)
    this.anchorToPet() // 重新锚定，保持底部尖角始终指向桌宠
  }

  // 桌宠移动时跟随（保持相对位置）
  follow(anchor) {
    this.anchor = anchor
    this.anchorToPet()
  }

  close() { if (this.isOpen) this.win.close() }

  // 收起（输入后转由桌宠显示 Deep diving，气泡隐藏但继续接收流式输出与尺寸变化）
  hide() { if (this.isOpen) this.win.hide() }

  // 展开（会话完成时重新显示，展示输出内容）
  reveal() {
    if (this.isOpen) { this.win.show(); this.win.focus() }
  }

  // 向气泡渲染层推送事件
  send(channel, payload) { if (this.isOpen) this.win.webContents.send(channel, payload) }
}

module.exports = { ChatWindow }
