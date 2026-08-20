// preload：向渲染层暴露拖拽窗口 + 接收/拉取状态的 IPC 接口
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: (sx, sy) => ipcRenderer.send('pet-drag-start', { sx, sy }),
  dragMove: (sx, sy) => ipcRenderer.send('pet-drag-move', { sx, sy }),
  onStatus: (callback) => {
    ipcRenderer.on('pet-status', (_event, status) => callback(status))
  },
  getStatus: () => ipcRenderer.invoke('pet-get-status'),
  toggleChat: () => ipcRenderer.invoke('pet-toggle-chat'),
  cancelChat: () => ipcRenderer.send('pet-cancel-chat'),
})
