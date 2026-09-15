import type { MuxFrame, RpcResult, ServerRequest, ServerResponse } from '../../shared/dsh'
import { authHeaders, getCookie, withAuth } from './auth'

/** rpcId 是外层 server-request 的 id —— 回答提问时必须原样回显它 */
type FrameHandler = (frame: MuxFrame, rpcId: string) => void

/** 传输形态：v2 = POST /api（0.1.5+）；legacy = POST /api/<method>（0.1.1 及更早） */
export type Transport = 'v2' | 'legacy'

/**
 * 下行流的候选路径。
 *
 * 新版 dsh 把流式事件挂在 `/api/remote.mux`（由 dsh-api-gateway 持有），
 * 旧版是 `/api/events.mux` + `/api/events.host` 两条。
 * 不写死：每条流按候选顺序试，连上就记住。
 */
/**
 * 把 v2 `$events` 流上的 `emit` 帧，翻译成气泡内部一直在用的 host/* 帧。
 *
 * 事件签名（Hermes 从 session 描述符里抄的原文）：
 *   api-session/activity'(sessionId, updatedAt)
 *   api-session/added'   (summary)
 *   api-session/error'   (sessionId, message)
 *   api-session/removed' (sessionId)
 *   api-session/status'  (sessionId, running)
 *
 * ⚠️ args 是【数组】（按位置），不是对象 —— 这点很容易写错。
 */
function translateEmit(event: string, args: unknown[]): Record<string, unknown> | null {
  const a0 = args[0] as Record<string, unknown> | undefined
  switch (event) {
    case 'api-session/added': {
      const summary = (a0?.summary ?? a0 ?? {}) as Record<string, unknown>
      return { type: 'host/session-added', sessionId: summary.sessionId, blank: false, summary }
    }
    case 'api-session/removed':
      return { type: 'host/session-removed', sessionId: typeof a0 === 'string' ? a0 : (a0 as never) }
    case 'api-session/status':
      return { type: 'host/session-status', sessionId: args[0], running: Boolean(args[1]) }
    case 'api-session/error':
      return { type: 'host/agent-error', sessionId: args[0], message: String(args[1] ?? '') }
    case 'api-session/activity':
      return { type: 'host/session-activity', sessionId: args[0], updatedAt: args[1] }
    default:
      // 其它事件目前用不上
      return null
  }
}

const MUX_PATHS = ['/api/remote.mux', '/api/events.mux']
const HOST_PATHS = ['/api/remote.mux', '/api/events.host']
type StatusHandler = (connected: boolean) => void

/**
 * dsh /api 的主进程客户端。
 * - 一元调用：POST /api/<method>（信封 client-request）
 * - 下行事件：**两条** WebSocket —— /api/events.mux（会话事件）与 /api/events.host（宿主事件）
 *   HTTP SSE 走同一路径会返回 426 Upgrade Required，所以必须用 WS。
 *
 * 主进程发起的请求不带 Origin 头，天然通过 dsh 的浏览器信任栅栏。
 */
/**
 * 把一个方法名 + 参数，翻译成某个传输形态下的「路径 + 封包」。
 *
 * ★ 这份映射是 Hermes 在那台机器上**实测**出来的，不是我猜的：
 *
 *   legacy (0.1.1)   POST /api/session.list
 *                    { method: 'session.list', payload: <P> }
 *
 *   v2     (0.1.5)   POST /api/session/list          ← 端点必须是【斜杠两段】
 *                    { method: 'session/list', payload: { args: { _request: <P> } } }
 *
 * v2 上「点号单段」的名字（如 host.describe）会被 claimsEndpoint 判为 false 直接 404 ——
 * 而 404 看起来像「认证没过」，我因此在错误的方向上查了很久。
 *
 * 另：Hermes 给了一张错误码对照表，以后照它辨向：
 *   404 = 端点未被认领（名字/格式不对）   415 = content-type 不对
 *   400 body is not JSON = 到了分发器      200 + ok:false = 到了方法层，参数不对
 */
/**
 * 每个端点的「形参名」。**这是 v2 最容易搞错的地方。**
 *
 * 规则：**args 的键 = 方法签名里声明的形参名，一个形参一个键，平铺。**
 * 名字来自各包 `lib/typert.host.js` 里的 `parameters[].name`（Hermes 给的抓手）。
 *
 * ⚠️ 我一开始以为有个通用的 `_request` 包裹层 —— **错的**。
 * `_request` 没有任何特殊含义，它只是 `session/list` 那个形参恰好叫这个名字。
 * `session/prompt` 的形参叫 `request`，`commands/execute` 有三个形参。
 * 写错就是 `args fields do not match the descriptor: unexpected/missing "xxx"`。
 *
 * 缺省按单形参 `request` 处理 —— 绝大多数控制器方法都是这个形状。
 */
const V2_PARAMS: Record<string, string[]> = {
  'session.list': ['_request'], // 只有它叫 _request（保留的空列表请求）
  'credentials.set': ['ref', 'value'],
  'commands/execute': ['agent', 'line', 'submittedAttachments'],
}

function toV2(method: string, payload: unknown, rpcId: string): { path: string; envelope: Record<string, unknown> } {
  const endpoint = method.replace(/\./g, '/') // session.list → session/list
  const params = V2_PARAMS[method] ?? ['request']
  // 单形参 → 包一层同名键；多形参 → 老 payload 本来就是按形参名平铺的，原样用
  const args =
    params.length === 1
      ? { [params[0]]: payload }
      : ((payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>)
  return {
    path: '/api/' + endpoint,
    // method 字段必须与 URL 里的端点**逐字相同**，否则 dsh 报 gateway/bad-request
    envelope: { type: 'client-request', rpcId, method: endpoint, payload: { args } },
  }
}

function toLegacy(method: string, payload: unknown, rpcId: string): { path: string; envelope: Record<string, unknown> } {
  return {
    path: '/api/' + method,
    envelope: { type: 'client-request', rpcId, method, payload },
  }
}

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
/**
 * 传输形态。dsh 换过一次 API 的挂法，两种都得支持。
 *
 *   legacy（0.1.1 及更早）  POST /api/<method>      封包整体作为 body
 *   v2    （0.1.5+）        POST /api               封包整体作为 body（方法名在封包里）
 *
 * v2 的依据是 Hermes 在那台机器上翻源码得到的：
 *   `/api` 由 dsh-client-connection 注册为一个 **prefix 路由**，
 *   README 原文「unclaimed requests return 404」—— 所以 `/api/host.describe` 这种
 *   「前缀 + 方法名」的拼法在 v2 上必然 404（不是没认证，是没这个路径）。
 *
 * 不写死其中一个：先按探测到的用，探测不到就两条都试一次，试通了记下来。
 */
  /** 已知能用的传输形态；null = 还没探出来 */
  private transport: Transport | null = null
  /** 下行流当前用到的候选下标（连不上就往后试） */
  private muxPathIdx = 0
  /** v2：当前跟住的会话（换会话时要 cancel 上一条流） */
  private followedId: string | null = null
  private hostPathIdx = 0

  getTransport(): Transport | null { return this.transport }

  private async callOnce<T>(path: string, envelope: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; result?: RpcResult<T>; text?: string }> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(withAuth(this.base + path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(envelope),
        signal: ac.signal,
      })
      if (!res.ok) return { status: res.status, text: (await res.text()).slice(0, 200) }
      const json = (await res.json()) as ServerResponse<T>
      return { status: res.status, result: json.result }
    } catch (err) {
      return { status: 0, text: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }


  /** 一元调用。永不抛：网络/协议失败都折成 RpcErr */
  async call<T = unknown>(method: string, payload: unknown = {}, timeoutMs = 60_000): Promise<RpcResult<T>> {
    const rid = 'b' + (++this.rid)

    // 已知形态 → 直接用，不再试
    if (this.transport) {
      const req = this.transport === 'v2' ? toV2(method, payload, rid) : toLegacy(method, payload, rid)
      const r = await this.callOnce<T>(req.path, req.envelope, timeoutMs)
      if (r.result) return r.result
      this.transport = null // 失效了，下次重探
      return { ok: false, error: { code: 'http-' + r.status, message: r.text ?? '' } }
    }

    // 未知 → 先试 v2（新版），失败再退回 legacy
    const v2 = toV2(method, payload, rid)
    const tryV2 = await this.callOnce<T>(v2.path, v2.envelope, timeoutMs)
    if (tryV2.result) { this.transport = 'v2'; console.log('[dsh] 传输形态 = v2（斜杠端点 + args/_request）'); return tryV2.result }
    const lg = toLegacy(method, payload, rid)
    const tryLegacy = await this.callOnce<T>(lg.path, lg.envelope, timeoutMs)
    if (tryLegacy.result) { this.transport = 'legacy'; console.log('[dsh] 传输形态 = legacy（POST /api/<method>）'); return tryLegacy.result }
    return { ok: false, error: { code: 'http-' + tryLegacy.status, message: tryLegacy.text ?? '' } }
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

  /** 建立下行流。v1 是两条 socket，v2 是一条 socket 上按 streamId 分流。 */
  connect(): void {
    if (this.closed) return
    if (this.transport === 'legacy') {
      if (!this.muxWs) this.openStream('/api/events.mux', false)
      if (!this.hostWs) this.openStream('/api/events.host', true)
      return
    }
    // v2（或还没探出形态）：一条 socket 到 /api/remote.mux
    if (!this.muxWs) this.openV2Mux()
  }

  /**
   * v2 的单一多路复用流。
   *
   * ★ 线协议（Hermes 抓的真帧 + stream-protocol.js 原文）：
   *
   *   客户端 → { type:'open', streamId, endpoint, payload }
   *            { type:'cancel', streamId }
   *   服务端 → { type:'item', streamId, value? }
   *            { type:'end' / 'error', streamId, error? }
   *
   * 关键三点：
   *   ① **连上之后必须显式发 open 才会收到帧** —— 不是「连上就有推送」
   *   ② 开流后第一条必定是 {type:'ready', clientId, host} —— **要等它才宣告 connected**
   *   ③ 两类事件靠 streamId 分，不靠帧内容
   */
  private openV2Mux(): void {
    const wsUrl = this.base.replace(/^http/, 'ws') + '/api/remote.mux'
    let ws: WebSocket
    try {
      const cookie = getCookie()
      ws = cookie ? new WebSocket(wsUrl, { headers: { cookie } } as never) : new WebSocket(wsUrl)
    } catch (err) {
      console.error('[dsh] WebSocket 构造失败:', err)
      this.scheduleReconnect()
      return
    }
    this.muxWs = ws
    let openedOnce = false

    ws.addEventListener('open', () => {
      openedOnce = true
      console.log('[dsh] remote.mux 已连上，开宿主事件流')
      // 注意：这里还【不】宣告 connected —— 要等 ready 帧
      try {
        ws.send(JSON.stringify({ type: 'open', streamId: 'host', endpoint: '$events', payload: { args: {} } }))
      } catch (err) {
        console.error('[dsh] 发 open 失败:', err)
      }
    })

    ws.addEventListener('message', (ev) => {
      let frame: { type?: string; streamId?: string; value?: unknown; error?: unknown }
      try {
        frame = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (frame.type === 'item') {
        const v = frame.value as { type?: string; clientId?: string } | undefined
        if (v && v.type === 'ready') {
          // ★ 真正的「连上了」以 ready 为准
          this.backoff = 1000
          this.setConnected(true)
          console.log('[dsh] mux ready, clientId=' + (v.clientId ?? '?'))
          // ready 之后才能开业务流 —— 顺序不能反
          if (this.followedId) this.followSession(this.followedId)
          return
        }
        // $events 流上的业务帧是 emit —— 事件名和老的 host/* 不同，要翻译
        const emit = v as { type?: string; event?: string; args?: unknown[] } | undefined
        if (emit && emit.type === 'emit') {
          const translated = translateEmit(emit.event ?? '', emit.args ?? [])
          if (translated) {
            for (const h of this.hostHandlers) {
              try { h(translated as never, '') } catch (err) { console.error('[dsh] handler 抛错:', err) }
            }
          }
          return
        }
        const handlers = frame.streamId === 'host' ? this.hostHandlers : this.muxHandlers
        for (const h of handlers) {
          try { h(v as never, '') } catch (err) { console.error('[dsh] handler 抛错:', err) }
        }
        return
      }
      if (frame.type === 'error') {
        console.error('[dsh] 流错误:', JSON.stringify(frame.error))
      }
    })

    ws.addEventListener('close', () => {
      this.muxWs = null
      this.setConnected(false)
      if (!openedOnce) this.transport = null // 连都没连上 → 形态判断可能是错的，重探
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* close 紧随其后 */ })
  }

  private openStream(path: string, isHost: boolean): void {
    const wsUrl = this.base.replace(/^http/, 'ws') + path
    // ⚠️ WS 也要带认证 —— 否则下行流 401，表现成「连上了但收不到任何事件」。
    //    dsh 0.1.5 用的是 Cookie（见 auth.ts 里的说明）。
    //    Node 的 WebSocket（WHATWG 形态）其实接受第二个参数带 headers —— 本机实测确认过。
    let ws: WebSocket
    try {
      const cookie = getCookie()
      ws = cookie ? new WebSocket(wsUrl, { headers: { cookie } } as never) : new WebSocket(wsUrl)
    } catch (err) {
      console.error('[dsh] WebSocket 构造失败:', err)
      this.scheduleReconnect()
      return
    }
    if (isHost) this.hostWs = ws
    else this.muxWs = ws

    // 没连上过就断开 → 说明这条路径不对，换候选里的下一条（只在这条流上换）
    let openedOnce = false
    ws.addEventListener('open', () => {
      openedOnce = true
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
      if (!openedOnce) {
        // 一次都没连上 → 换候选路径（新旧版的流路径不同）
        if (isHost && this.hostPathIdx < HOST_PATHS.length - 1) {
          this.hostPathIdx += 1
          console.log('[dsh] host 流换路径 → ' + HOST_PATHS[this.hostPathIdx])
        } else if (!isHost && this.muxPathIdx < MUX_PATHS.length - 1) {
          this.muxPathIdx += 1
          console.log('[dsh] mux 流换路径 → ' + MUX_PATHS[this.muxPathIdx])
        }
      }
      if (!this.muxWs && !this.hostWs) this.setConnected(false)
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* close 会紧随其后 */ })
  }

/**
 * 让 v2 的 mux 跟住某个会话。
 *
 * v1 的 mux 流是【自动】跟当前会话的（服务端推 session/subscribed）。
 * v2 不是 —— 必须显式 open 一条 session/follow，而且 address 是带 kind 的联合类型：
 *
 *   { kind:'session', sessionId }                      ← 普通会话
 *   { kind:'subagent', parentSessionId, childSessionId, mode }
 *
 * 从会话列表里拿到的就是 kind:'session' 这一种。
 */
  followSession(sessionId: string | null): void {
    if (this.transport !== 'v2' || !this.muxWs || this.muxWs.readyState !== 1) return
    // 先撤掉上一条
    if (this.followedId) {
      try { this.muxWs.send(JSON.stringify({ type: 'cancel', streamId: 'sess' })) } catch { /* ignore */ }
      this.followedId = null
    }
    if (!sessionId) return
    try {
      this.muxWs.send(
        JSON.stringify({
          type: 'open',
          streamId: 'sess',
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                maxMessages: 50,
                assistantStream: true,
              },
            },
          },
        }),
      )
      this.followedId = sessionId
      console.log('[dsh] 已跟住会话 ' + sessionId)
    } catch (err) {
      console.error('[dsh] 开 session/follow 失败:', err)
    }
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
