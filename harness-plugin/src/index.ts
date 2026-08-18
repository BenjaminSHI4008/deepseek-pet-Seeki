/**
 * dsh-pet-status — DeepSeek Harness 桌宠状态广播插件。
 *
 * 订阅 harness 的两条事件流，把 agent 当前活动派生为一个 PetStatus，并经本地
 * WebSocket 广播给桌宠客户端：
 *
 *   - `host` 流里的 `host/session-status`（running 布尔）决定「空闲 vs 工作中」；
 *   - `mux` 流里的 `assistant/chunk` 原始流式事件决定细粒度状态：
 *       reasoning-delta  → thinking
 *       tool-call-delta  → searching（工具名含 search）或 working
 *       text-delta       → generating
 *
 * WebSocket 协议（JSON 文本帧）：
 *   服务器 → 客户端：{ "type": "status", "status": "idle" | "thinking" | ... }
 *   客户端 → 服务器：v1 忽略；v2 预留消息上行位（桌宠输入 → harness）。
 *
 * @module dsh-pet-status
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
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
  /** WebSocket 路径，默认 `/api/pet.ws`。 */
  path?: string
}

/** 桌宠活动状态。 */
export type PetStatus = 'idle' | 'thinking' | 'searching' | 'working' | 'generating'

/** 由一条流式 chunk 派生状态；不认识（block 边界/usage/finish）返回 null 表示不变。 */
function statusFromChunk(chunk: { type: string; name?: string }): PetStatus | null {
  switch (chunk.type) {
    case 'reasoning-delta':
      return 'thinking'
    case 'text-delta':
      return 'generating'
    case 'tool-call-delta':
      return chunk.name !== undefined && chunk.name.toLowerCase().includes('search')
        ? 'searching'
        : 'working'
    default:
      return null
  }
}

/**
 * Mounts the status broadcaster.
 * @param ctx - Plugin context carrying webServer + apiProxy.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const path = config.path ?? '/api/pet.ws'
  const server = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  // 聚合状态：running 集合判定「空闲 vs 工作中」，status 记录最近一次细粒度 chunk。
  let status: PetStatus = 'thinking'
  const running = new Set<string>()

  const current = (): PetStatus => (running.size === 0 ? 'idle' : status)
  const broadcast = (): void => {
    const payload = JSON.stringify({ type: 'status', status: current() })
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }

  // 订阅事件流（dispose 时 abort）。
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
        if (event.type !== 'assistant/chunk') continue
        const next = statusFromChunk(event.data.chunk)
        if (next !== null) {
          status = next
          broadcast()
        }
      }
    })().catch(() => {})

    void (async () => {
      for await (const frame of host) {
        const payload = frame.payload
        if (payload.type !== 'host/session-status') continue
        if (payload.running) running.add(payload.sessionId)
        else running.delete(payload.sessionId)
        broadcast()
      }
    })().catch(() => {})

    return () => abort.abort()
  }, 'pet-status: event streams')

  // WebSocket 升级路由。
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path,
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
}
