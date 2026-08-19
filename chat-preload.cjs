// 聊天窗口 preload：向聊天框渲染层暴露 chatAPI（发送 / 打断 / 关闭 / 接收流式回复）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text) => ipcRenderer.send('chat-send', text),
  cancel: () => ipcRenderer.send('chat-cancel'),
  newConversation: () => ipcRenderer.send('chat-new'),
  openWeb: () => ipcRenderer.send('chat-open-web'),
  close: () => ipcRenderer.send('chat-close'),
  onEvent: (callback) => ipcRenderer.on('chat-event', (_event, msg) => callback(msg)),
})
