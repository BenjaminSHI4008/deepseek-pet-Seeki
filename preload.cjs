// preload：向渲染层暴露拖拽窗口的 IPC 接口
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: (sx, sy) => ipcRenderer.send('pet-drag-start', { sx, sy }),
  dragMove: (sx, sy) => ipcRenderer.send('pet-drag-move', { sx, sy }),
})
