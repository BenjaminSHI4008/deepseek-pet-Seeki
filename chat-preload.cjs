// 聊天窗口 preload：向聊天框渲染层暴露 chatAPI（发送 / 关闭 / 接收流式回复与状态）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text) => ipcRenderer.send('chat-send', text),
  close: () => ipcRenderer.send('chat-close'),
  onMessage: (callback) => ipcRenderer.on('chat-message', (_event, msg) => callback(msg)),
  onStatus: (callback) => ipcRenderer.on('chat-status', (_event, status) => callback(status)),
})
