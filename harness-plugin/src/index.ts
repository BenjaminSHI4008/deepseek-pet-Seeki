/**
 * dsh-pet-status — DeepSeek Harness 桌宠状态广播插件（兼桌宠管理器）。
 *
 * 1) 订阅事件流，把 agent 活动收敛为 running / completed / terminated 并广播；
 * 2) 经本地 WebSocket 广播状态；
 * 3) 自动拉起桌宠（Electron 子进程），退出/重启时一并管理；
 * 4) 提供桌宠管理 HTTP API：配置读写、帧上传/预览、重启。
 *
 * @module dsh-pet-status
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { readFile, writeFile, mkdir, readdir, unlink, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Stable Cordis plugin name（cordis.yml 里用它挂载）。 */
export const name = 'pet-status'

/** Services required before apply. */
export const inject = ['webServer', 'apiProxy']

/** Plugin config. */
export interface Config {
  /** WebSocket 路径。 */
  path?: string
  /** 桌宠应用目录（Electron 应用根，含 package.json + node_modules/.bin/electron）。 */
  petDir?: string
  /** 启动时自动拉起桌宠。 */
  autoStart?: boolean
  /** 桌宠退出时是否连带停止 harness（仅桌面图标启动器托管时生效，见 apply 内 stopWithPet 推导）。 */
  stopWithPet?: boolean
}

export const Config: z<Config> = z.object({
  path: z.string().default('/api/pet.ws'),
  petDir: z.string().default(''),
  autoStart: z.boolean().default(false),
  // 无 default 即可选（schemastery 无 .optional()，缺省字段本身就可空）：
  // 由 apply 按「是否启动器托管」推导（启动器默认退即停，手动默认常驻）。
  stopWithPet: z.boolean(),
})

/** 桌宠活动状态（任务维度，对应 statuses 里的 received/running/completed/terminated）。 */
export type PetStatus = 'received' | 'running' | 'completed' | 'terminated'

/** 读取请求体为 UTF-8 文本。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 把动作名净化为安全的目录名。 */
function sanitizeFolder(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'action'
}

const PNG_MAGIC = '89504e470d0a1a0a'
/** 精灵帧尺寸上限（现有帧 128~160px；240px 窗口 / SCALE 1.5 下超过即溢出）。 */
const MAX_FRAME_DIM = 256

/** 校验 PNG 魔数并读 IHDR 宽高；非 PNG 或过短返回 null。 */
function pngDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== PNG_MAGIC) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** 响应 JSON。 */
function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** 从 assistant 消息里折叠出纯文本（过滤 tool 等非文本块）。 */
function extractText(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? []
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/**
 * 聊天服务：单一职责——管理 harness 会话（创建/发消息/取消），并把 assistant 文本流式回传。
 * 依赖注入：api（ApiProxy）与 emit（向桌宠广播 JSON 消息），不直接触碰 WebSocket。
 */
class ChatService {
  private sessionId: string | null = null
  private workspacePath: string | null = null
  private workspaceId: string | null = null
  private currentModel: { provider: string; model: string } | null = null
  private readonly api: ApiProxy
  private readonly emit: (msg: Record<string, unknown>) => void
  private readonly onPromptAccepted?: () => void

  constructor(api: ApiProxy, emit: (msg: Record<string, unknown>) => void, onPromptAccepted?: () => void) {
    this.api = api
    this.emit = emit
    this.onPromptAccepted = onPromptAccepted
  }

  /** 列出所有工作区（对话文件夹），返回 {id, title, path}。 */
  async listFolders(): Promise<Array<{ id: string; title: string; path: string }>> {
    const res = await this.api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} })
    if (!res.result.ok) return []
    return res.result.value.items.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path }))
  }

  /** 广播文件夹列表 + 当前选中 id。 */
  async emitFolders(): Promise<void> {
    const folders = await this.listFolders()
    this.emit({ type: 'chat-folders', folders, currentId: this.workspaceId })
  }

  /** 列出某工作区下的会话（按工作区 sessionIds 顺序），返回 {id, title, updatedAt}。 */
  async listSessions(workspaceId: string): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    const [listRes, wsRes] = await Promise.all([
      this.api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} }),
      this.api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} }),
    ])
    if (!listRes.result.ok || !wsRes.result.ok) return []
    const ws = wsRes.result.value.items.find((w) => String(w.workspaceId) === workspaceId)
    const ordered = ws?.sessionIds ?? []
    const byId = new Map(listRes.result.value.items.map((i) => [String(i.sessionId), i]))
    return ordered.map((sid, i) => {
      const it = byId.get(String(sid))
      const proj = it?.projections?.values as { title?: string | null } | undefined
      const title = typeof proj?.title === 'string' && proj.title ? proj.title : ''
      return {
        id: String(sid),
        title: title || (it?.blank ? '新对话' : `对话 ${i + 1}`),
        updatedAt: it?.updatedAt ?? 0,
      }
    })
  }

  /** 广播当前工作区的会话列表 + 当前选中会话 id。 */
  async emitSessions(): Promise<void> {
    if (!this.workspaceId) { this.emit({ type: 'chat-sessions', sessions: [], currentId: null }); return }
    const sessions = await this.listSessions(this.workspaceId)
    this.emit({ type: 'chat-sessions', sessions, currentId: this.sessionId })
  }

  /** 列出可用模型目录（来自 harness llm.models，非硬编码），返回 {provider, model, name, description}。 */
  async listModels(): Promise<Array<{ provider: string; model: string; name: string; description?: string }>> {
    const res = await this.api.llm.models({ rpcId: RpcId(randomUUID()), payload: {} })
    if (!res.result.ok) return []
    const models: Array<{ provider: string; model: string; name: string; description?: string }> = []
    for (const group of res.result.value.groups) {
      for (const m of group.models) {
        models.push({ provider: group.id, model: m.id, name: m.name, description: m.description })
      }
    }
    return models
  }

  /** 广播模型目录 + 当前选中模型。 */
  async emitModels(): Promise<void> {
    const models = await this.listModels()
    this.emit({ type: 'chat-models', models, current: this.currentModel })
  }

  /** 回读会话当前模型（会话属性，重开会话可恢复）。 */
  async readCurrentModel(): Promise<void> {
    if (!this.sessionId) { this.currentModel = null; return }
    try {
      const res = await this.api.sessions.models({ rpcId: RpcId(randomUUID()), payload: { sessionId: this.sessionId } })
      if (res.result.ok) {
        this.currentModel = { provider: res.result.value.current.provider, model: res.result.value.current.model }
      }
    } catch {
      this.currentModel = null
    }
  }

  /** 切换模型（会话属性，仅影响下一次新请求；无会话则暂存，创建会话后应用）。 */
  async selectModel(provider: string, model: string): Promise<void> {
    const prev = this.currentModel
    this.currentModel = { provider, model }
    if (this.sessionId) {
      try {
        const res = await this.api.sessions.selectModel({
          rpcId: RpcId(randomUUID()),
          payload: { sessionId: this.sessionId, provider, model },
        })
        if (!res.result.ok) throw new Error(res.result.error.code)
      } catch (error) {
        this.currentModel = prev // 失败回退原模型
        this.emit({ type: 'chat-error', message: `无法切换模型，请检查模型配置（${String(error)}）` })
        await this.emitModels()
        return
      }
    }
    await this.emitModels()
  }

  /** 初始化：用桌宠记住的目录路径解析/创建工作区作为默认文件夹，并加载其历史。 */
  async init(workspacePath: string): Promise<void> {
    try {
      if (workspacePath) await this.ensureWorkspace(workspacePath)
    } catch {
      // 路径失效等情况：仍广播列表，让用户手动选择
    }
    if (this.workspaceId) await this.selectFolder(this.workspaceId) // 加载当前文件夹历史 + 广播列表
    else { await this.emitFolders(); await this.emitModels() }
  }

  /** 确保工作区存在（幂等）：换工作区则顺带重置会话。 */
  async ensureWorkspace(path: string): Promise<string> {
    if (this.workspaceId && this.workspacePath === path) return this.workspaceId
    const res = await this.api.workspace.create({ rpcId: RpcId(randomUUID()), payload: { path } })
    if (!res.result.ok) throw new Error(`工作区创建失败：${res.result.error.code}`)
    this.workspacePath = path
    this.workspaceId = String(res.result.value.workspace.workspaceId)
    this.sessionId = null // 换工作区 = 新会话
    return this.workspaceId
  }

  /** 切换到某文件夹：广播其会话列表，并默认进入最近会话（attach prepend：第一个最新）。 */
  async selectFolder(workspaceId: string): Promise<void> {
    this.workspaceId = workspaceId
    this.sessionId = null
    await this.emitFolders()
    const sessions = await this.listSessions(workspaceId)
    this.emit({ type: 'chat-sessions', sessions, currentId: null })
    if (sessions.length > 0) await this.selectSession(sessions[0].id)
    else {
      this.emit({ type: 'chat-history', messages: [] })
      await this.readCurrentModel()
      await this.emitModels()
    }
  }

  /** 进入某个具体会话：加载其历史并广播（会话选择器切换 / 文件夹默认进入最近会话）。 */
  async selectSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId
    const messages = await this.readHistory(sessionId)
    this.emit({ type: 'chat-history', messages })
    await this.emitSessions()
    await this.readCurrentModel() // 恢复该会话的模型
    await this.emitModels()
  }

  /** 读取某会话历史，折叠成 user/assistant 文本消息序列。 */
  async readHistory(sessionId: string): Promise<Array<{ role: string; text: string }>> {
    const res = await this.api.sessions.history({ rpcId: RpcId(randomUUID()), payload: { sessionId } })
    if (!res.result.ok) return []
    const messages: Array<{ role: string; text: string }> = []
    for (const entry of res.result.value.events) {
      const event = entry.event
      if (event.type === 'user/message') {
        const text = extractText(event.data)
        if (text) messages.push({ role: 'user', text })
      } else if (event.type === 'assistant/message') {
        const text = extractText((event.data as { message?: unknown }).message)
        if (text) messages.push({ role: 'assistant', text })
      }
    }
    return messages
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId
    if (!this.workspaceId) throw new Error('未选择对话文件夹')
    const res = await this.api.sessions.create({ rpcId: RpcId(randomUUID()), payload: { workspaceId: this.workspaceId } })
    if (!res.result.ok) throw new Error(`会话创建失败：${res.result.error.code}`)
    this.sessionId = String(res.result.value.sessionId)
    // 应用当前选中的模型（继承自当前会话/上次选择）
    if (this.currentModel) {
      await this.api.sessions.selectModel({
        rpcId: RpcId(randomUUID()),
        payload: { sessionId: this.sessionId, provider: this.currentModel.provider, model: this.currentModel.model },
      })
    }
    void this.emitSessions() // 新会话已创建，刷新会话下拉
    return this.sessionId
  }

  async send(text: string): Promise<void> {
    try {
      const sessionId = await this.ensureSession()
      const res = await this.api.sessions.prompt({
        rpcId: RpcId(randomUUID()),
        payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      })
      if (!res.result.ok) throw new Error(`prompt 失败：${res.result.error.code}`)
      this.onPromptAccepted?.() // 通知 apply：收到发送 → 桌宠进入 received（收到啦）
      this.emit({ type: 'chat-started' })
    } catch (error) {
      this.emit({ type: 'chat-error', message: String(error) })
    }
  }

  /** 另起新对话：下次 send 会用新会话（当前文件夹内）。 */
  newConversation(): void {
    this.sessionId = null
    void this.emitSessions() // currentId=null → 前端回到「新对话」态
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return
    const res = await this.api.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: { sessionId: this.sessionId } })
    if (!res.result.ok) throw new Error(`打断失败：${res.result.error.code}`)
  }

  /** 处理 mux 流帧：仅关心本会话的 assistant 文本事件（分片/完整消息/结束）。 */
  handleFrame(frame: { type: string; sessionId?: unknown; event?: { type: string; data?: unknown } }): void {
    if (frame.type !== 'session/event' || frame.sessionId !== this.sessionId) return
    const event = frame.event
    if (!event) return
    if (event.type === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: { type?: string; text?: string } })?.chunk
      if (chunk?.type === 'text-delta' && chunk.text) this.emit({ type: 'chat-delta', text: chunk.text })
    } else if (event.type === 'assistant/message') {
      const text = extractText((event.data as { message?: unknown })?.message)
      if (text) this.emit({ type: 'chat-message', text })
    } else if (event.type === 'turn/end') {
      this.emit({ type: 'chat-done' })
    }
  }
}

/**
 * Mounts the status broadcaster and the pet manager APIs.
 * @param ctx - Plugin context carrying webServer + apiProxy.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const pathname = config.path ?? '/api/pet.ws'
  const server = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  // 正在运行的会话集合：非空 = running；空 = completed 或 terminated。
  const running = new Set<string>()
  // 最近一次 turn 是否以 error/aborted 结束（报错 / 手动停止）。
  let terminated = false
  // 刚收到发送、agent 尚未进入 running：短暂显示「收到啦」。
  let received = false
  // running 归零后延迟一拍再广播，等 mux 流的 turn/end 先到（两个流投递顺序不保证）。
  let endedTimer: ReturnType<typeof setTimeout> | null = null

  const current = (): PetStatus => {
    if (running.size > 0) return 'running'
    if (received) return 'received'
    return terminated ? 'terminated' : 'completed'
  }
  const send = (msg: Record<string, unknown>): void => {
    const payload = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }
  const broadcast = (): void => send({ type: 'status', status: current() })
  // 生命周期：桌宠退出是否连带停止 harness。
  // 桌面图标启动器用 PET_LAUNCHER=1 拉起 → 默认「退出即停」；手动 pnpm dsh web → 默认「保留后台」，
  // 两者都可经 cordis 配置的 stopWithPet 显式覆盖。
  const launcherManaged = process.env.PET_LAUNCHER === '1'
  const stopWithPet = launcherManaged ? config.stopWithPet !== false : config.stopWithPet === true
  // 聊天服务：桥接桌宠 ↔ harness 会话（复用同一条 WS）
  const chat = new ChatService(ctx.apiProxy, send, () => {
    // 收到发送：进入 received；若 agent 已在运行则不动（避免打断 running）。
    if (running.size > 0) return
    received = true
    broadcast()
    // 兜底：agent 迟迟未进入 running（异常）时 3s 后回落，避免「收到啦」常驻。
    setTimeout(() => {
      if (received && running.size === 0) { received = false; broadcast() }
    }, 3000)
  })
  const scheduleEnded = (): void => {
    if (endedTimer) clearTimeout(endedTimer)
    endedTimer = setTimeout(() => {
      endedTimer = null
      broadcast()
    }, 80)
  }

  // 订阅事件流（mux 取 turn 结束原因，host 取 running 状态；dispose 时 abort）。
  ctx.effect(() => {
    const abort = new AbortController()
    const api: ApiProxy = ctx.apiProxy
    const mux = api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
    const host = api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)

    void (async () => {
      for await (const frame of mux) {
        const payload = frame.payload
        chat.handleFrame(payload as { type: string; sessionId?: unknown; event?: { type: string; data?: unknown } }) // 聊天：转发 assistant 文本
        if (payload.type !== 'session/event') continue
        const event = payload.event
        if (event.type !== 'turn/end') continue
        const kind = event.data.reason.kind
        terminated = kind === 'error' || kind === 'aborted'
        received = false // turn 结束即离开「收到啦」
      }
    })().catch(() => {})

    void (async () => {
      for await (const frame of host) {
        const payload = frame.payload
        if (payload.type === 'host/session-status') {
          if (payload.running) {
            running.add(payload.sessionId)
            terminated = false
            received = false // 进入 running，离开「收到啦」
            if (endedTimer) { clearTimeout(endedTimer); endedTimer = null }
            broadcast()
          } else {
            running.delete(payload.sessionId)
            if (running.size === 0) scheduleEnded()
            else broadcast()
          }
        } else if (payload.type === 'host/agent-error') {
          terminated = true
        }
      }
    })().catch(() => {})

    return () => {
      abort.abort()
      if (endedTimer) clearTimeout(endedTimer)
    }
  }, 'pet-status: event streams')

  // WebSocket 升级路由。
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: pathname,
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws)
        ws.send(JSON.stringify({ type: 'status', status: current() }))
        ws.on('close', () => clients.delete(ws))
        ws.on('error', () => clients.delete(ws))
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as { type?: string; text?: string; workspacePath?: string; workspaceId?: string; sessionId?: string; provider?: string; model?: string }
            if (msg.type === 'chat-init') void chat.init(msg.workspacePath ?? '')
            else if (msg.type === 'chat') void chat.send(msg.text ?? '')
            else if (msg.type === 'chat-select-folder') void chat.selectFolder(msg.workspaceId ?? '')
            else if (msg.type === 'chat-select-session') void chat.selectSession(msg.sessionId ?? '')
            else if (msg.type === 'chat-select-model') void chat.selectModel(msg.provider ?? '', msg.model ?? '')
            else if (msg.type === 'chat-new') chat.newConversation()
            else if (msg.type === 'chat-cancel') void chat.cancel()
            else if (msg.type === 'pet-shutdown' && stopWithPet) {
              // 桌宠退出 → 连带停止 harness（仅启动器托管/显式配置时）。
              stopPet()
              setTimeout(() => process.exit(0), 30)
            }
          } catch {
            // 非 JSON 消息忽略
          }
        })
      })
    },
  }), 'pet-status: WebSocket route')

  // dispose 时清理客户端连接。
  ctx.effect(() => () => {
    for (const ws of clients) ws.terminate()
    server.close()
  }, 'pet-status: cleanup')

  // ── 桌宠子进程管理 ────────────────────────────────────────────────
  const petDir = config.petDir ?? ''
  const configFile = petDir ? path.join(petDir, 'pet.config.json') : ''
  let petChild: ChildProcess | null = null

  const readConfig = async (): Promise<Record<string, unknown> | null> => {
    if (!configFile) return null
    try {
      return JSON.parse(await readFile(configFile, 'utf8'))
    } catch {
      return null
    }
  }
  const writeConfig = async (cfg: unknown): Promise<void> => {
    await writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n')
  }
  const startPet = (force = false): void => {
    // force=true 供 /api/pet.start 幂等唤起；启动时的自动拉起仍尊重 autoStart。
    if (!force && !config.autoStart) return
    if (!petDir || petChild) return
    // 直接用 process.execPath 跑 electron/cli.js，不依赖 PATH 上的 node——
    // 桌面图标启动器以最小 PATH 拉起 harness，`#!/usr/bin/env node` 的 .bin/electron 符号链接会静默失败。
    const electronCli = path.join(petDir, 'node_modules', 'electron', 'cli.js')
    const wsUrl = `ws://127.0.0.1:${String(ctx.webServer.port)}${pathname}`
    const child = spawn(process.execPath, [electronCli, '.'], {
      cwd: petDir,
      // PET_MANAGED 标记「由插件拉起」，桌宠据此决定退出时是否回报 pet-shutdown。
      env: { ...process.env, PET_WS_URL: wsUrl, PET_MANAGED: '1' },
      stdio: 'ignore',
    })
    petChild = child
    // 桌宠退出/崩溃后释放引用，否则 petChild 永远指向已死进程，/api/pet.start 再也无法唤起。
    const release = (): void => { if (petChild === child) petChild = null }
    child.on('error', (error) => { console.error('[pet-status] 拉起桌宠失败：', error); release() })
    child.on('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[pet-status] 桌宠异常退出（code ${code}）`)
      release()
    })
  }
  const stopPet = (): void => {
    if (petChild) { petChild.kill(); petChild = null }
  }

  // ── 配置管理 API ──────────────────────────────────────────────────
  if (configFile) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/pet.config',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          try {
            const text = await readFile(configFile, 'utf8')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(text)
          } catch {
            json(res, 404, { ok: false, error: 'config not found' })
          }
        } else if (req.method === 'PUT') {
          try {
            const cfg = JSON.parse(await readBody(req))
            await writeConfig(cfg)
            json(res, 200, { ok: true })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error) })
          }
        } else {
          res.writeHead(405)
          res.end()
        }
      },
    }), 'pet-status: config API')
  }

  // ── 帧上传 / 预览 / 重启 API ──────────────────────────────────────
  if (configFile && petDir) {
    // 上传/替换某动作的帧序列
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/pet.frames',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        try {
          const { action, label, fps, frames } = JSON.parse(await readBody(req))
          if (typeof action !== 'string' || !action) throw new Error('action 必填')
          if (!Array.isArray(frames) || frames.length === 0) throw new Error('frames 至少一张')

          const cfg = await readConfig()
          if (cfg === null) throw new Error('config not found')
          const actions = (cfg.actions ?? {}) as Record<string, { label?: string; fps?: number; folder: string; count: number; intro?: [number, number] }>
          const existing = actions[action]
          const folder = existing?.folder ?? sanitizeFolder(action)

          // 先全部解码并校验（PNG 魔数 + 尺寸上限），再写盘——避免半截写坏目录
          const bufs: Buffer[] = []
          for (let i = 0; i < frames.length; i++) {
            const data = (frames[i] as { data?: unknown })?.data
            if (typeof data !== 'string') throw new Error(`frame ${i} 缺少 data`)
            const buf = Buffer.from(data, 'base64')
            const dims = pngDims(buf)
            if (!dims) throw new Error(`frame ${i} 不是 PNG`)
            if (dims.w > MAX_FRAME_DIM || dims.h > MAX_FRAME_DIM) {
              throw new Error(`frame ${i} 尺寸 ${dims.w}×${dims.h} 超出上限 ${MAX_FRAME_DIM}×${MAX_FRAME_DIM}，请上传像素精灵帧`)
            }
            bufs.push(buf)
          }
          const frameDir = path.join(petDir, 'Deepseek', 'animations', folder, 'south')
          await mkdir(frameDir, { recursive: true })
          for (const f of await readdir(frameDir).catch(() => [])) {
            if (f.endsWith('.png')) await unlink(path.join(frameDir, f))
          }
          for (let i = 0; i < bufs.length; i++) {
            await writeFile(path.join(frameDir, `frame_${String(i).padStart(3, '0')}.png`), bufs[i])
          }

          // 更新配置（替换帧时清掉 intro，新动作无 intro）
          actions[action] = {
            label: label !== undefined ? String(label) : (existing?.label ?? action),
            fps: fps !== undefined ? Number(fps) : (existing?.fps ?? 5),
            folder,
            count: frames.length,
          }
          cfg.actions = actions
          await writeConfig(cfg)
          json(res, 200, { ok: true, action, folder, count: frames.length })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'pet-status: frames API')

    // 帧图片预览
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/pet/frames',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const rel = (req.url ?? '').split('?')[0].slice('/pet/frames/'.length)
        const parts = rel.split('/')
        if (parts.length !== 2) { res.writeHead(404); res.end(); return }
        const [folder, file] = parts
        if (!/^[a-zA-Z0-9_-]+$/.test(folder) || !/^frame_\d{3}\.png$/.test(file)) {
          res.writeHead(404)
          res.end()
          return
        }
        try {
          const buf = await readFile(path.join(petDir, 'Deepseek', 'animations', folder, 'south', file))
          res.writeHead(200, { 'content-type': 'image/png' })
          res.end(buf)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    }), 'pet-status: frames preview')

    // 幂等唤起桌宠（桌面图标启动器调用；已在运行则 no-op）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/pet.start',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        startPet(true)
        json(res, 200, { ok: true })
      },
    }), 'pet-status: pet start')

    // 重启桌宠（帧/配置改动后热生效）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/pet.restart',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        stopPet()
        startPet()
        json(res, 200, { ok: true })
      },
    }), 'pet-status: restart')

    // 删除动作（连带删帧目录 + 引用回退）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/pet.action',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'DELETE') { res.writeHead(405); res.end(); return }
        try {
          const { action } = JSON.parse(await readBody(req))
          if (typeof action !== 'string' || !action) throw new Error('action 必填')
          const cfg = await readConfig()
          if (cfg === null) throw new Error('config not found')
          const actions = (cfg.actions ?? {}) as Record<string, { label?: string; fps?: number; folder: string; count: number; intro?: [number, number] }>
          if (!actions[action]) throw new Error(`动作 "${action}" 不存在`)

          // 计算回退动作：优先 idle，其次任意剩余动作
          const rest = Object.keys(actions).filter((k) => k !== action)
          if (rest.length === 0) throw new Error('不能删除最后一个动作')
          const fallback = rest.includes('idle') ? 'idle' : rest[0]

          // 回退引用（v3：characterStates）
          const cs = (cfg.characterStates ?? {}) as Record<string, { play?: unknown[]; returnTo?: unknown; before?: unknown; after?: unknown; directions?: Record<string, { play?: unknown[] }> }>
          const repointPlay = (key: string): void => {
            const st = cs[key]
            if (!st || !Array.isArray(st.play)) return
            st.play = st.play.filter((a) => a !== action)
            if (st.play.length === 0) st.play = [fallback]
          }
          repointPlay('default')
          repointPlay('click')
          if (cs.click && cs.click.returnTo === action) cs.click.returnTo = fallback
          if (cs.drag) {
            if (cs.drag.returnTo === action) cs.drag.returnTo = fallback
            if (cs.drag.directions) {
              for (const d of Object.values(cs.drag.directions)) {
                if (Array.isArray(d.play)) {
                  d.play = d.play.filter((a) => a !== action)
                  if (d.play.length === 0) d.play = [fallback]
                }
              }
            }
          }
          if (cs.timeout) {
            if (cs.timeout.before === action) cs.timeout.before = fallback
            if (cs.timeout.after === action) cs.timeout.after = fallback
          }
          const statuses = (cfg.statuses ?? {}) as Record<string, { actions?: unknown[] }>
          for (const s of Object.values(statuses)) {
            if (Array.isArray(s.actions)) {
              s.actions = s.actions.filter((a) => a !== action)
            }
          }

          // 删动作条目 + 帧目录（目录名不安全时跳过文件删除，仅删配置）
          const folder = actions[action].folder
          delete actions[action]
          cfg.actions = actions
          if (/^[a-zA-Z0-9_-]+$/.test(folder)) {
            await rm(path.join(petDir, 'Deepseek', 'animations', folder), { recursive: true, force: true })
          }
          await writeConfig(cfg)
          json(res, 200, { ok: true, action, fallback })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'pet-status: action delete')
  }

  // Web 配置管理页面（/pet/settings）
  const settingsHtmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../settings.html')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet/settings',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      try {
        const html = await readFile(settingsHtmlPath, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('settings page not found')
      }
    },
  }), 'pet-status: settings page')

  // 生命周期：dispose 时关闭桌宠；启动时拉起
  ctx.effect(() => () => stopPet(), 'pet-status: pet subprocess')
  startPet()
}
