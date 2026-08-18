/**
 * dsh-pet-status — DeepSeek Harness 桌宠状态广播插件。
 *
 * 1) 订阅 host 事件流里的 `host/session-status`（agent running 翻转），把状态收敛为两态：
 *    - `working`：至少一个会话在运行（agent 工作中）；
 *    - `idle`：没有会话在运行（任务完成 / 空闲）。
 * 2) 经本地 WebSocket 广播状态。
 * 3) （可选）启动时自动拉起桌宠（Electron 子进程），退出时一并关闭 —— 实现
 *    「`pnpm dsh web` 时桌宠同步启动」。
 *
 * WebSocket 协议（JSON 文本帧）：
 *   服务器 → 客户端：{ "type": "status", "status": "working" | "idle" }
 *
 * @module dsh-pet-status
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
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

/** 桌宠活动状态。 */
export type PetStatus = 'idle' | 'working' | 'terminated'

/**
 * Mounts the status broadcaster (and optionally the pet subprocess).
 * @param ctx - Plugin context carrying webServer + apiProxy.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const pathname = config.path ?? '/api/pet.ws'
  const server = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  // 正在运行的会话集合：非空 = working；空 = idle 或 terminated。
  const running = new Set<string>()
  // 最近一次 turn 是否以 error/aborted 结束（报错 / 手动停止）。
  let terminated = false
  // running 归零后延迟一拍再广播，等 mux 流的 turn/end 先到（两个流投递顺序不保证）。
  let endedTimer: ReturnType<typeof setTimeout> | null = null

  const current = (): PetStatus => {
    if (running.size > 0) return 'working'
    return terminated ? 'terminated' : 'idle'
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
            terminated = false // 新 turn 开始
            if (endedTimer) { clearTimeout(endedTimer); endedTimer = null }
            broadcast()
          } else {
            running.delete(payload.sessionId)
            if (running.size === 0) scheduleEnded() // 延迟一拍，等 turn/end
            else broadcast()
          }
        } else if (payload.type === 'host/agent-error') {
          terminated = true // 崩溃类错误（无 turn 位置）
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
        // 连上即推当前状态，避免客户端空窗。
        ws.send(JSON.stringify({ type: 'status', status: current() }))
        ws.on('close', () => clients.delete(ws))
        ws.on('error', () => clients.delete(ws))
        // v1 忽略客户端上行；v2 在此接「桌宠输入 → harness」。
        ws.on('message', () => {})
      })
    },
  }), 'pet-status: WebSocket route')

  // dispose 时清理客户端连接。
  ctx.effect(() => () => {
    for (const ws of clients) ws.terminate()
    server.close()
  }, 'pet-status: cleanup')

  // 配置管理 API（插件作为桌宠管理器，读写 <petDir>/pet.config.json）
  const configFile = config.petDir ? path.join(config.petDir, 'pet.config.json') : ''
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
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end('{"ok":false,"error":"config not found"}')
          }
        } else if (req.method === 'PUT') {
          const body = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
          })
          try {
            const cfg = JSON.parse(body)
            await writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true}')
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          }
        } else {
          res.writeHead(405)
          res.end()
        }
      },
    }), 'pet-status: config API')
  }

  // 自动拉起桌宠子进程。
  if (config.autoStart && config.petDir) {
    const electronBin = path.join(config.petDir, 'node_modules', '.bin', 'electron')
    const wsUrl = `ws://127.0.0.1:${String(ctx.webServer.port)}${pathname}`
    const child: ChildProcess = spawn(electronBin, ['.'], {
      cwd: config.petDir,
      env: { ...process.env, PET_WS_URL: wsUrl },
      stdio: 'ignore',
    })
    child.on('error', (error) => {
      console.error('[pet-status] 拉起桌宠失败：', error)
    })
    ctx.effect(() => () => {
      child.kill()
    }, 'pet-status: pet subprocess')
  }
}
