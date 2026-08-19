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
}

export const Config: z<Config> = z.object({
  path: z.string().default('/api/pet.ws'),
  petDir: z.string().default(''),
  autoStart: z.boolean().default(false),
})

/** 桌宠活动状态（任务维度，对应 statuses 里的 running/completed/terminated）。 */
export type PetStatus = 'running' | 'completed' | 'terminated'

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
  // running 归零后延迟一拍再广播，等 mux 流的 turn/end 先到（两个流投递顺序不保证）。
  let endedTimer: ReturnType<typeof setTimeout> | null = null

  const current = (): PetStatus => {
    if (running.size > 0) return 'running'
    return terminated ? 'terminated' : 'completed'
  }
  const broadcast = (): void => {
    const payload = JSON.stringify({ type: 'status', status: current() })
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }
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
        if (payload.type !== 'session/event') continue
        const event = payload.event
        if (event.type !== 'turn/end') continue
        const kind = event.data.reason.kind
        terminated = kind === 'error' || kind === 'aborted'
      }
    })().catch(() => {})

    void (async () => {
      for await (const frame of host) {
        const payload = frame.payload
        if (payload.type === 'host/session-status') {
          if (payload.running) {
            running.add(payload.sessionId)
            terminated = false
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
        ws.on('message', () => {})
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
  const startPet = (): void => {
    if (!config.autoStart || !petDir || petChild) return
    const electronBin = path.join(petDir, 'node_modules', '.bin', 'electron')
    const wsUrl = `ws://127.0.0.1:${String(ctx.webServer.port)}${pathname}`
    petChild = spawn(electronBin, ['.'], {
      cwd: petDir,
      env: { ...process.env, PET_WS_URL: wsUrl },
      stdio: 'ignore',
    })
    petChild.on('error', (error) => { console.error('[pet-status] 拉起桌宠失败：', error) })
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
          const cs = (cfg.characterStates ?? {}) as Record<string, { play?: unknown[]; returnTo?: unknown; before?: unknown; after?: unknown }>
          const repointPlay = (key: string): void => {
            const st = cs[key]
            if (!st || !Array.isArray(st.play)) return
            st.play = st.play.filter((a) => a !== action)
            if (st.play.length === 0) st.play = [fallback]
          }
          repointPlay('default')
          repointPlay('click')
          repointPlay('drag')
          if (cs.click && cs.click.returnTo === action) cs.click.returnTo = fallback
          if (cs.drag && cs.drag.returnTo === action) cs.drag.returnTo = fallback
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
