/**
 * dsh-pet-status — DeepSeek Harness 桌宠状态广播插件。
 *
 * 只订阅 host 事件流里的 `host/session-status`（agent running 翻转），把状态收敛为两态：
 *   - `working`：至少一个会话在运行（agent 工作中）；
 *   - `idle`：没有会话在运行（任务完成 / 空闲）。
 *
 * WebSocket 协议（JSON 文本帧）：
 *   服务器 → 客户端：{ "type": "status", "status": "working" | "idle" }
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
export type PetStatus = 'idle' | 'working'

/**
 * Mounts the status broadcaster.
 * @param ctx - Plugin context carrying webServer + apiProxy.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const path = config.path ?? '/api/pet.ws'
  const server = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  // 正在运行的会话集合：非空 = working，空 = idle。
  const running = new Set<string>()

  const current = (): PetStatus => (running.size === 0 ? 'idle' : 'working')
  const broadcast = (): void => {
    const payload = JSON.stringify({ type: 'status', status: current() })
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }

  // 订阅 host 事件流（dispose 时 abort）。
  ctx.effect(() => {
    const abort = new AbortController()
    const api: ApiProxy = ctx.apiProxy
    const host = api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)

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
  }, 'pet-status: host stream')

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
