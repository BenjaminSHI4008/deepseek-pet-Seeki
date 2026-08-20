// 聊天窗口 preload：向聊天框渲染层暴露 chatAPI（发送 / 打断 / 关闭 / 接收流式回复）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text) => ipcRenderer.send('chat-send', text),
  cancel: () => ipcRenderer.send('chat-cancel'),
  newConversation: () => ipcRenderer.send('chat-new'),
  selectFolder: (id, path) => ipcRenderer.send('chat-select-folder', { id, path }),
  selectSession: (sessionId) => ipcRenderer.send('chat-select-session', { sessionId }),
  selectModel: (provider, model) => ipcRenderer.send('chat-select-model', { provider, model }),
  openWeb: () => ipcRenderer.send('chat-open-web'),
  resize: (height) => ipcRenderer.send('chat-resize', height),
  close: () => ipcRenderer.send('chat-close'),
  onEvent: (callback) => ipcRenderer.on('chat-event', (_event, msg) => callback(msg)),
})
