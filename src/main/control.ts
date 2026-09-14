import { createServer, type Server } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import type { Snapshot, BubbleState } from '../shared/types'
import { dataDir, endpointPath, buildStateText } from './context'

export interface ControlDeps {
  snapshot: () => Snapshot | null
  bubbleState: () => BubbleState
  /** 当前感知档位与说明（不注入上下文，供 MCP 工具按需查询） */
  perception: () => { mode: string; hint: string }
  /** 执行一个气泡动作，返回给 MCP 的结果 */
  command: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
}

let server: Server | null = null

/**
 * 本地控制接口：给 MCP server（独立进程）驱动气泡用。
 * 只绑 127.0.0.1，端口由系统分配后写进 endpoint.json —— 不做鉴权，
 * 因为只在本机回环上、且启动方（MCP server）本来就与本应用同权限。
 */
export function startControlServer(deps: ControlDeps): void {
  if (server) return
  server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(text)
    }
    if (req.method === 'GET' && req.url === '/state') {
      const snap = deps.snapshot()
      const bubble = deps.bubbleState()
      send(200, { ok: true, text: buildStateText(snap, bubble), data: snap, perception: deps.perception() })
      return
    }
    if (req.method === 'POST' && req.url === '/cmd') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(raw || '{}') as { cmd?: string; args?: Record<string, unknown> }
            const out = await deps.command(String(parsed.cmd ?? ''), parsed.args ?? {})
            send(200, { ok: true, result: out })
          } catch (err) {
            send(200, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })()
      })
      return
    }
    send(404, { ok: false, error: 'not found' })
  })

  server.listen(0, '127.0.0.1', () => {
    const addr = server?.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(
        endpointPath(),
        JSON.stringify({ port, url: 'http://127.0.0.1:' + port, pid: process.pid, updatedAt: Date.now() }, null, 2),
        'utf8',
      )
      console.log('[control] 本地控制接口已就绪 http://127.0.0.1:' + port)
    } catch (err) {
      console.error('[control] 写 endpoint.json 失败', err)
    }
  })
}

export function stopControlServer(): void {
  try { server?.close() } catch { /* ignore */ }
  server = null
}
