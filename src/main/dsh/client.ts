import type { MuxFrame, RpcResult, ServerRequest, ServerResponse } from '../../shared/dsh'
import { authHeaders, withAuth } from './auth'

/** rpcId 是外层 server-request 的 id —— 回答提问时必须原样回显它 */
type FrameHandler = (frame: MuxFrame, rpcId: string) => void
type StatusHandler = (connected: boolean) => void

/**
 * dsh /api 的主进程客户端。
 * - 一元调用：POST /api/<method>（信封 client-request）
 * - 下行事件：**两条** WebSocket —— /api/events.mux（会话事件）与 /api/events.host（宿主事件）
 *   HTTP SSE 走同一路径会返回 426 Upgrade Required，所以必须用 WS。
 *
 * 主进程发起的请求不带 Origin 头，天然通过 dsh 的浏览器信任栅栏。
 */
export class DshClient {
  private readonly base: string
  private muxWs: WebSocket | null = null
  private hostWs: WebSocket | null = null
  private rid = 0
  private closed = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoff = 1000
  private readonly muxHandlers = new Set<FrameHandler>()
  private readonly hostHandlers = new Set<FrameHandler>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private connected = false

  constructor(base: string) {
    this.base = base.replace(/\/$/, '')
  }

  get url(): string { return this.base }
  isConnected(): boolean { return this.connected }

  onMux(cb: FrameHandler): () => void {
    this.muxHandlers.add(cb)
    return () => this.muxHandlers.delete(cb)
  }

  onHost(cb: FrameHandler): () => void {
    this.hostHandlers.add(cb)
    return () => this.hostHandlers.delete(cb)
  }

  onStatus(cb: StatusHandler): () => void {
    this.statusHandlers.add(cb)
    cb(this.connected)
    return () => this.statusHandlers.delete(cb)
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return
    this.connected = v
    for (const h of this.statusHandlers) h(v)
  }

  /** 一元调用。永不抛：网络/协议失败都折成 RpcErr */
  async call<T = unknown>(method: string, payload: unknown = {}, timeoutMs = 60_000): Promise<RpcResult<T>> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(withAuth(this.base + '/api/' + method), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ type: 'client-request', rpcId: 'b' + (++this.rid), method, payload }),
        signal: ac.signal,
      })
      if (!res.ok) {
        return { ok: false, error: { code: 'http-' + res.status, message: (await res.text()).slice(0, 200) } }
      }
      const json = (await res.json()) as ServerResponse<T>
      return json.result ?? { ok: false, error: { code: 'empty', message: 'no result' } }
    } catch (err) {
      return { ok: false, error: { code: 'transport', message: err instanceof Error ? err.message : String(err) } }
    } finally {
      clearTimeout(timer)
    }
  }

  async value<T = unknown>(method: string, payload: unknown = {}): Promise<T | undefined> {
    const r = await this.call<T>(method, payload)
    return r.ok ? r.value : undefined
  }

  /**
   * 回答服务端的问询（审批 / 提问）。
   * /api/respond 收的是 client-response 信封，rpcId 必须回显请求方的那个：
   * - 审批：rpcId 用 approvalId
   * - 提问：rpcId 用 question/requested 帧的 rpcId
   */
  async respond(rpcId: string, value: unknown): Promise<RpcResult<unknown>> {
    try {
      const res = await fetch(withAuth(this.base + '/api/respond'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
      })
      if (!res.ok) return { ok: false, error: { code: 'http-' + res.status, message: await res.text() } }
      return { ok: true, value: await res.json() }
    } catch (err) {
      return { ok: false, error: { code: 'transport', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  /** 同时打开 mux 与 host 两条下行流；任一条断开都会触发整体重连 */
  connect(): void {
    if (this.closed) return
    if (!this.muxWs) this.openStream('/api/events.mux', false)
    if (!this.hostWs) this.openStream('/api/events.host', true)
  }

  private openStream(path: string, isHost: boolean): void {
    // WS 也要带 token —— 否则下行流连不上，表现成「连上了但收不到事件」
    const wsUrl = withAuth(this.base.replace(/^http/, 'ws') + path)
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      console.error('[dsh] WebSocket 构造失败:', err)
      this.scheduleReconnect()
      return
    }
    if (isHost) this.hostWs = ws
    else this.muxWs = ws

    ws.addEventListener('open', () => {
      this.backoff = 1000
      this.setConnected(true)
      console.log('[dsh] ' + path + ' 已连接')
    })

    ws.addEventListener('message', (ev) => {
      let frame: ServerRequest
      try {
        frame = JSON.parse(String(ev.data)) as ServerRequest
      } catch {
        return
      }
      const payload = frame?.payload
      if (!payload || typeof payload !== 'object') return
      const handlers = isHost ? this.hostHandlers : this.muxHandlers
      for (const h of handlers) {
        try { h(payload, frame.rpcId) } catch (err) { console.error('[dsh] ' + path + ' handler 抛错:', err) }
      }
    })

    ws.addEventListener('close', () => {
      if (isHost) this.hostWs = null
      else this.muxWs = null
      if (!this.muxWs && !this.hostWs) this.setConnected(false)
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* close 会紧随其后 */ })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 15_000)
    console.log('[dsh] 下行流断开，' + delay + 'ms 后重连')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try { this.muxWs?.close() } catch { /* ignore */ }
    try { this.hostWs?.close() } catch { /* ignore */ }
    this.muxWs = null
    this.hostWs = null
    this.setConnected(false)
  }
}
