// 截图专用 preload：为桌宠 / 聊天渲染层提供桩数据，脱离真实 harness 也能渲染出演示内容。
// 仅被 scripts/capture.js 使用，不参与正式运行。
const { contextBridge } = require('electron')

const FOLDERS = [{ id: 'ws1', title: 'deepseek-pet', path: '~/deepseek-pet' }]
const SESSIONS = [
  { id: 's1', title: '规划桌宠截图方案' },
  { id: 's2', title: '给 Seeki 写 README' },
  { id: 's3', title: '修复聊天滚动区域' },
]
const MODELS = [
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
]
const HISTORY = [
  { role: 'user', text: '帮我规划一下桌宠的截图方案' },
  { role: 'assistant', text: '好的，建议拍 4 张：Hero（桌宠 + 聊天）、一次真实对话、工作区 / 模型切换、角色状态。' },
  { role: 'user', text: '能直接帮我拍吗？' },
  { role: 'assistant', text: '可以，我来构图并截图。' },
]

contextBridge.exposeInMainWorld('chatAPI', {
  send: () => {},
  cancel: () => {},
  newConversation: () => {},
  selectFolder: () => {},
  selectSession: () => {},
  selectModel: () => {},
  openWeb: () => {},
  resize: () => {},
  close: () => {},
  onEvent: (cb) => {
    const t = (ms, m) => setTimeout(() => cb(m), ms)
    t(60, { type: 'chat-folders', folders: FOLDERS, currentId: 'ws1' })
    t(90, { type: 'chat-sessions', sessions: SESSIONS, currentId: 's1' })
    t(120, { type: 'chat-models', models: MODELS, current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } })
    t(150, { type: 'chat-history', messages: HISTORY })
  },
})

contextBridge.exposeInMainWorld('petAPI', {
  onStatus: (cb) => { setTimeout(() => cb('running'), 220) }, // 让头顶气泡显示 "Deep diving..."
  getStatus: async () => 'completed',
  dragStart: () => {},
  dragMove: () => {},
  toggleChat: () => {},
  cancelChat: () => {},
})
