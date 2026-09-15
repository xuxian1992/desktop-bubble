import type { DshClient } from '../dsh/client'
import type { MuxFrame, RawSessionSummary, SessionEventEnvelope } from '../../shared/dsh'
import type {
  Attachment, ChatRow, ContextStats, InboxAnswer, InboxItem, ModelCatalogView, ModelGroup,
  PermissionStats, SessionStatus, SessionSummary, SessionView, Snapshot, TokenStats, WorkspaceSummary,
} from '../../shared/types'

/** 一个会话的本地状态。rows 是**聚合后**的可渲染单元，不是原始事件。 */
interface SessionRecord {
  sessionId: string
  rows: ChatRow[]
  liveText: string
  lastSeq: number
  /** mux 基线里的 lastSeq（session/subscribed 给的），用于缺口检测 */
  baselineLastSeq: number | null
  loading: boolean
  loaded: boolean
  error?: string
  hasMore: boolean
  /** 加载历史期间缓冲的实时事件，装窗后回放 */
  pending: SessionEventEnvelope[]
  needsResync: boolean
  running: boolean
  tokens?: TokenStats
  context?: ContextStats
  permissions?: PermissionStats
}

const HISTORY_WINDOW = 14 // 气泡首屏窗口，比 web 端的 50 小得多（见方案 §14.4）

/* ---------------- 内容块工具 ---------------- */

type Block = { type: string; text: string }

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out: Block[] = []
  for (const b of content) {
    if (typeof b === 'string') { out.push({ type: 'text', text: b }); continue }
    if (!b || typeof b !== 'object') continue
    const blk = b as Record<string, unknown>
    const type = typeof blk.type === 'string' ? blk.type : 'text'
    const text = typeof blk.text === 'string' ? blk.text : ''
    out.push({ type, text })
  }
  return out
}

function joinText(bs: Block[]): string {
  return bs.map((b) => b.text).join('')
}

function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

/* ---------------- 事件 → 行 的聚合（历史回放与实时共用同一条路径） ---------------- */

function applyEvent(rec: { rows: ChatRow[]; liveText: string; running: boolean }, ev: SessionEventEnvelope): void {
  const d = (ev.data ?? {}) as Record<string, any>
  switch (ev.type) {
    case 'user/message': {
      // 只显示真人输入。plugin（运行时上下文快照）/ skill-catalog 等注入内容不进气泡，
      // 否则小窗口会被系统提示刷屏。
      const src = d.source as { kind?: string } | undefined
      if (src?.kind !== 'user') return
      const parts: any[] = Array.isArray(d.content) ? d.content : []
      const hasImage = parts.some((c) => c?.type === 'image')
      const text = joinText(blocks(d.content)) || (hasImage ? '（截图）' : '')
      if (!text) return
      rec.liveText = ''
      const id = String(d.id ?? 'u' + ev.seq)
      // 发送时乐观插入过一条本地行 → 用服务端这条替换掉，避免重复
      const last = rec.rows[rec.rows.length - 1]
      if (last && last.kind === 'user' && last.id.startsWith('local-') && last.text === text) {
        rec.rows[rec.rows.length - 1] = { kind: 'user', id, text, time: ev.time, hasImage }
        return
      }
      rec.rows.push({ kind: 'user', id, text, time: ev.time, hasImage })
      return
    }
    case 'assistant/chunk': {
      const c = d.chunk as { type?: string; text?: string } | undefined
      if (c?.type === 'text-delta' && typeof c.text === 'string') rec.liveText += c.text
      return
    }
    case 'assistant/message': {
      const bs = blocks(d.message?.content)
      const text = joinText(bs.filter((b) => b.type === 'text'))
      const reasoning = joinText(bs.filter((b) => b.type === 'reasoning'))
      rec.liveText = ''
      if (!text && !reasoning) return
      rec.rows.push({
        kind: 'assistant',
        id: String(d.message?.id ?? 'a' + ev.seq),
        text,
        reasoning: reasoning || undefined,
        time: ev.time,
      })
      const u = d.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined
      if (u) {
        const prev = rec as unknown as { tokens?: TokenStats }
        prev.tokens = {
          input: (prev.tokens?.input ?? 0) + (u.inputTokens ?? 0),
          output: (prev.tokens?.output ?? 0) + (u.outputTokens ?? 0),
          cacheRead: (prev.tokens?.cacheRead ?? 0) + (u.cacheReadTokens ?? 0),
        }
      }
      return
    }
    case 'tool/call': {
      rec.rows.push({
        kind: 'tool',
        id: String(d.callId ?? 't' + ev.seq),
        name: String(d.name ?? 'tool'),
        status: 'running',
        time: ev.time,
      })
      return
    }
    case 'tool/result':
    case 'tool/error': {
      const callId = String(d.message?.source?.callId ?? '')
      const inner = Array.isArray(d.message?.content)
        ? d.message.content.find((c: any) => c?.toolCallId || c?.type === 'tool-result')
        : undefined
      const preview = clip(joinText(blocks(inner?.content)))
      const idx = rec.rows.findIndex((r) => r.kind === 'tool' && r.id === callId)
      if (idx >= 0) {
        const row = rec.rows[idx] as Extract<ChatRow, { kind: 'tool' }>
        rec.rows[idx] = { ...row, status: ev.type === 'tool/error' ? 'error' : 'done', preview: preview || row.preview }
      } else if (preview) {
        rec.rows.push({
          kind: 'tool', id: callId || 't' + ev.seq, name: String(d.message?.source?.kind ?? 'tool'),
          status: 'done', preview, time: ev.time,
        })
      }
      return
    }
    case 'turn/start': {
      rec.running = true
      return
    }
    case 'turn/end': {
      rec.liveText = ''
      rec.running = false
      return
    }
    default:
      return
  }
}

/* ---------------- Store ---------------- */

/**
 * 路径是否指同一个目录。
 * Windows 大小写不敏感，且末尾分隔符、斜杠方向都要归一化 ——
 * 否则 `E:\harness专区` 与 `E:\harness专区\` 会被当成两个目录，工作区就登记不上。
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+$/, '').replace(/\//g, '\\')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

export class SessionStore {
  private readonly client: DshClient
  private readonly summaries = new Map<string, SessionSummary>()
  private readonly records = new Map<string, SessionRecord>()
  private readonly inbox = new Map<string, InboxItem>()
  /** 已归档会话：session.list **不会**替我们过滤，客户端自己摘掉 */
  private readonly archived = new Set<string>()
  private workspaces: WorkspaceSummary[] = []
  private catalogView: ModelCatalogView | null = null
  private currentId: string | null = null
  private openGeneration = 0
  private model?: { provider: string; model: string; reasoningEffort?: string }
  private catalog?: { groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }
  private busState: Snapshot['bus'] = { state: 'starting', url: '', owned: false }
  private readonly listeners = new Set<() => void>()
  private notifyTimer: NodeJS.Timeout | null = null
  private listTimer: NodeJS.Timeout | null = null

  constructor(client: DshClient) {
    this.client = client
    client.onMux((f, rpcId) => this.ingest(f, rpcId))
    // host/* 帧（会话新增/移除/运行状态/归档变更）走的是另一条流
    client.onHost((f, rpcId) => this.ingest(f, rpcId))
  }

  /* ---- 订阅 ---- */

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(delay = 60): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      for (const l of this.listeners) {
        try { l() } catch (e) { console.error('[store] listener 抛错', e) }
      }
    }, delay)
  }

  setBus(bus: Snapshot['bus']): void {
    this.busState = bus
    this.notify(0)
  }

  /* ---- 会话列表 ---- */

  async syncList(): Promise<void> {
    const ws = await this.client.value<{
      items?: Array<{ workspaceId: string; path: string; title: string; sessionIds?: string[] }>
      archivedSessionIds?: string[]
    }>('workspace.list', {})
    if (ws) {
      if (Array.isArray(ws.archivedSessionIds)) {
        this.archived.clear()
        for (const id of ws.archivedSessionIds) this.archived.add(id)
      }
      if (Array.isArray(ws.items)) {
        this.workspaces = ws.items.map((w) => ({
          workspaceId: w.workspaceId,
          path: w.path,
          title: w.title || w.path,
          sessionIds: w.sessionIds ?? [],
        }))
      }
    }
    const res = await this.client.call<{ items: RawSessionSummary[] }>('session.list', {})
    if (!res.ok) return
    const next = new Map<string, SessionSummary>()
    for (const raw of res.value.items ?? []) {
      next.set(raw.sessionId, {
        sessionId: raw.sessionId,
        title: String(raw.projections?.values?.title ?? '') || '(未命名)',
        updatedAt: raw.updatedAt,
        running: raw.running,
        blank: raw.blank,
        cwd: raw.cwd,
        agentPreset: raw.agentPreset,
        parentSessionId: raw.parentSessionId,
        isSubagent: raw.origin === 'subagent',
      })
      const rec = this.records.get(raw.sessionId)
      if (rec) rec.running = raw.running
      const vals = raw.projections?.values as Record<string, any> | undefined
      if (vals) {
        // 权限档位就写在列表项上 —— 它在【列表阶段】就有，跟会话加载无关。
        // （原来只在 rec 上写，而遍历列表时 rec 还不存在 → 永远拿不到。这是权限指示器
        //   从来没显示过的原因。）
        const pm = vals.permissions
        if (pm && Array.isArray(pm.options) && pm.currentValue) {
          const perm = { options: pm.options, currentValue: String(pm.currentValue) }
          const item = next.get(raw.sessionId)
          if (item) item.permissions = perm
          if (rec) rec.permissions = perm
        }
      }
      if (rec && vals) {
        const tu = vals.tokenUsage
        if (tu) rec.tokens = { input: tu.uncachedInputTokens ?? 0, output: tu.outputTokens ?? 0, cacheRead: tu.cacheReadTokens ?? 0 }
        const cp = vals.contextPressure
        if (cp) rec.context = { used: cp.pressureTokens ?? 0, window: cp.contextWindow ?? 0 }
      }
    }
    this.summaries.clear()
    for (const [k, v] of next) this.summaries.set(k, v)
    this.notify(0)
  }

  /**
   * 在**当前会话**上执行一条斜杠命令（如 `/permission workspace-write`）。
   *
   * 为什么不能用 session.prompt 发这条文本：实测过 —— prompt 只是把文字发给模型，
   * 命令根本不会被执行（档位纹丝不动）。命令走的是另一条通道：
   *
   *   POST /api/commands/execute
   *   { args: { agentId, line, images: [] } }
   *
   * 参数必须包在 args 里，否则报「Remote payload must contain exactly one plain-object args field」。
   * 这是从 dsh-client-runtime 的 client.js 里挖出来的（它内部叫 remote.commands.execute）。
   */
  async runCommand(line: string): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.currentId
    if (!sessionId) return { ok: false, error: '没有当前会话' }
    const res = await this.client.call<{ result?: { kind: string; text?: string } }>('commands/execute', {
      args: { agentId: sessionId, line, images: [] },
    })
    if (!res.ok) return { ok: false, error: res.error?.message ?? '命令执行失败' }
    const r = res.value?.result
    if (r && r.kind === 'error') return { ok: false, error: r.text ?? '命令返回错误' }
    return { ok: true }
  }

  private scheduleListSync(): void {
    if (this.listTimer) return
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      void this.syncList()
    }, 800)
  }

  /* ---- 帧分发 ---- */

  private ingest(frame: MuxFrame, rpcId: string): void {
    switch (frame.type) {
      case 'session/event': {
        const f = frame as Extract<MuxFrame, { type: 'session/event' }>
        this.onSessionEvent(f.sessionId, f.event)
        return
      }
      case 'session/subscribed': {
        const f = frame as Extract<MuxFrame, { type: 'session/subscribed' }>
        const rec = this.ensure(f.sessionId)
        rec.baselineLastSeq = f.lastSeq
        return
      }
      case 'approval/requested': {
        const f = frame as Extract<MuxFrame, { type: 'approval/requested' }>
        this.inbox.set(f.approvalId, {
          id: f.approvalId, sessionId: f.sessionId, sessionTitle: this.titleOf(f.sessionId),
          kind: 'approval', toolName: f.toolName, reason: f.reason, time: Date.now(),
        })
        this.notify(0)
        return
      }
      case 'approval/resolved': {
        const f = frame as Extract<MuxFrame, { type: 'approval/resolved' }>
        this.inbox.delete(f.approvalId)
        this.notify(0)
        return
      }
      case 'question/requested': {
        const f = frame as Extract<MuxFrame, { type: 'question/requested' }>
        // 提问的应答必须回显这一帧的 rpcId，所以 id 就用它
        this.inbox.set(rpcId, {
          id: rpcId, sessionId: f.sessionId, sessionTitle: this.titleOf(f.sessionId),
          kind: 'question', questions: f.questions as InboxItem['questions'], time: Date.now(),
        })
        this.notify(0)
        return
      }
      case 'question/resolved': {
        const f = frame as Extract<MuxFrame, { type: 'question/resolved' }>
        for (const [k, v] of this.inbox) if (v.sessionId === f.sessionId && v.kind === 'question') this.inbox.delete(k)
        this.notify(0)
        return
      }
      case 'host/session-status': {
        const f = frame as Extract<MuxFrame, { type: 'host/session-status' }>
        const rec = this.records.get(f.sessionId)
        if (rec) rec.running = f.running
        const sum = this.summaries.get(f.sessionId)
        if (sum) sum.running = f.running
        this.notify(0)
        return
      }
      case 'host/archived-sessions-changed': {
        const f = frame as unknown as { archivedSessionIds?: string[] }
        this.archived.clear()
        for (const id of f.archivedSessionIds ?? []) this.archived.add(id)
        this.notify(0)
        this.scheduleListSync()
        return
      }
      case 'host/session-added':
      case 'host/session-removed':
        this.scheduleListSync()
        return
      default:
        return
    }
  }

  private onSessionEvent(sessionId: string, ev: SessionEventEnvelope): void {
    const rec = this.ensure(sessionId)
    if (rec.loading) {
      rec.pending.push(ev)
      return
    }
    if (ev.seq <= rec.lastSeq) return // 去重
    if (rec.lastSeq > 0 && ev.seq > rec.lastSeq + 1) {
      console.warn('[store] seq 缺口 ' + rec.lastSeq + ' → ' + ev.seq + '，触发重同步')
      rec.needsResync = true
      if (sessionId === this.currentId) void this.open(sessionId)
    }
    rec.lastSeq = ev.seq
    applyEvent(rec, ev)
    if (sessionId === this.currentId) this.notify()
  }

  private ensure(sessionId: string): SessionRecord {
    let rec = this.records.get(sessionId)
    if (!rec) {
      rec = {
        sessionId, rows: [], liveText: '', lastSeq: 0, baselineLastSeq: null,
        loading: false, loaded: false, hasMore: false, pending: [], needsResync: false, running: false,
      }
      this.records.set(sessionId, rec)
    }
    return rec
  }

  private titleOf(sessionId: string): string {
    return this.summaries.get(sessionId)?.title ?? '(未命名)'
  }

  /* ---- 打开会话：照抄 dsh web 端 doOpen 的算法（方案 §14） ---- */

  async open(sessionId: string): Promise<void> {
    this.currentId = sessionId
    // v2 的下行流要显式跟会话；v1 会自动跟，这里是 no-op
    this.client.followSession(sessionId)
    const gen = ++this.openGeneration
    const rec = this.ensure(sessionId)
    rec.loading = true
    rec.error = undefined
    rec.pending = []
    this.notify(0)

    const fetchWindow = async () => {
      const res = await this.client.call<{ events: Array<{ event: SessionEventEnvelope }>; hasMore: boolean }>(
        'session.history', { sessionId, maxMessages: HISTORY_WINDOW })
      return res
    }

    let res = await fetchWindow()
    if (gen !== this.openGeneration) return // 被更晚的 open 取代，整体丢弃
    if (!res.ok) {
      rec.loading = false
      rec.error = res.error.message
      this.notify(0)
      return
    }
    this.installWindow(rec, res.value)

    // 缺口检测：mux 基线领先于历史窗口尾部 → 再拉一次（§14 的 lastSeq 比对）
    if (rec.baselineLastSeq !== null && rec.lastSeq < rec.baselineLastSeq) {
      res = await fetchWindow()
      if (gen !== this.openGeneration) return
      if (res.ok) this.installWindow(rec, res.value)
    }

    rec.loading = false
    rec.loaded = true
    rec.needsResync = false
    this.notify(0)

    // 顺带拿一下模型目录（用于状态条/发送前校验）
    const m = await this.client.value<{
      current?: { provider: string; model: string }
      groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    }>('session.models', { sessionId })
    if (m?.current) {
      this.model = m.current
      this.catalog = { groups: m.groups }
      this.refreshCatalogView()
      this.notify(0)
    }
  }

  private installWindow(rec: SessionRecord, value: { events?: Array<{ event: SessionEventEnvelope }>; hasMore?: boolean }): void {
    const events = (value.events ?? []).map((e) => e.event).filter(Boolean)
    rec.rows = []
    rec.liveText = ''
    rec.lastSeq = 0
    for (const ev of events) {
      applyEvent(rec, ev)
      if (ev.seq > rec.lastSeq) rec.lastSeq = ev.seq
    }
    rec.hasMore = Boolean(value.hasMore)
    // 回放加载期间缓冲的实时事件（保证不丢、不重）
    const buffered = rec.pending
    rec.pending = []
    for (const ev of buffered) {
      if (ev.seq <= rec.lastSeq) continue
      rec.lastSeq = ev.seq
      applyEvent(rec, ev)
    }
  }

  /* ---- 动作 ---- */

  async prompt(text: string, attachments: Attachment[] = []): Promise<void> {
    const sessionId = this.currentId
    if (!sessionId) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return

    const hasImage = attachments.some((a) => a.kind === 'image')
    const rec = this.ensure(sessionId)
    rec.rows.push({
      kind: 'user',
      id: 'local-' + Date.now(),
      text: trimmed || '（附件）',
      time: Date.now(),
      hasImage,
      attachCount: attachments.length,
    })
    rec.running = true
    this.notify(0)

    // 三种附件策略 → 拼成 dsh 只认的 text / image 两种 part
    const content: Array<Record<string, unknown>> = []
    if (trimmed) content.push({ type: 'text', text: trimmed })
    for (const a of attachments) {
      if (a.kind === 'image') {
        content.push({ type: 'image', mediaType: a.mediaType, data: a.base64, name: a.name })
      } else if (a.kind === 'text') {
        content.push({
          type: 'text',
          text: '文件 ' + a.name + '（' + a.path + '）：\n\n```\n' + a.content + '\n```',
        })
      } else {
        content.push({ type: 'text', text: '文件：' + a.path })
      }
    }

    const send = () =>
      this.client.call('session.prompt', {
        sessionId,
        mode: 'queue',
        content,
        clientTimeZone: 'Asia/Shanghai',
      })

    let res = await send()

    // 当前模型吃不下图 → 自动切到视觉模型再试一次（dsh 只在服务端判模态）
    if (!res.ok && hasImage && /does not support image|MODEL_DOES_NOT_SUPPORT_IMAGES/i.test(res.error.message)) {
      const vision = this.findVisionModel()
      if (vision) {
        const sw = await this.client.call('session.selectModel', {
          sessionId, provider: vision.provider, model: vision.id,
        })
        if (sw.ok) {
          this.model = { provider: vision.provider, model: vision.id }
          this.refreshCatalogView()
          rec.rows.push({
            kind: 'notice', id: 'sw-' + Date.now(),
            text: '已临时切到视觉模型 ' + vision.id + ' 来看图', time: Date.now(),
          })
          this.notify(0)
          res = await send()
        }
      }
    }

    if (!res.ok) {
      const hint = hasImage && /does not support image|MODEL_DOES_NOT_SUPPORT_IMAGES/i.test(res.error.message)
        ? '当前没有可用的视觉模型，这张图发不出去'
        : '发送失败：' + res.error.message
      rec.rows.push({ kind: 'notice', id: 'err-' + Date.now(), text: hint, time: Date.now() })
      rec.running = false
      this.notify(0)
    }
  }

  async cancel(): Promise<void> {
    if (!this.currentId) return
    await this.client.call('session.cancel', { sessionId: this.currentId })
  }

  /**
   * 新建会话。
   *
   * ⚠️ 这里是「在 harness专区 新建，却出现在别的分组里」的根因所在，值得写清楚：
   *
   * dsh 的 `session.create` 接受 **workspaceId 或 cwd 二选一**，而且两条路不等价：
   *
   *   - 传 `workspaceId` → dsh 建完会调 `workspace.attachSession()`，会话**登记进工作区**；
   *   - 传 `cwd`        → 会话有了目录，但**不属于任何工作区**，只能落到列表底部的「未分组」。
   *
   * 原来的代码只传 cwd，于是bubble 建的会话永远进不了工作区。
   * 而它连 cwd 都取错了：用的是 `recentCwds()[0]`（**全局最近更新的那个 cwd**），
   * 不是「你现在正在看的那个会话的 cwd」—— 所以还会跑到别的目录去。
   *
   * 现在：优先用当前会话的 cwd；若该 cwd 有对应工作区，就走 workspaceId。
   */
  async createSession(cwd?: string): Promise<void> {
    const current = this.currentId ? this.summaries.get(this.currentId)?.cwd : undefined
    const target = cwd ?? current ?? this.recentCwds()[0]

    const payload: Record<string, unknown> = {}
    if (target) {
      const ws = this.workspaces.find((w) => samePath(w.path, target))
      // 有工作区就走 workspaceId（会被 attachSession 接管）；没有才退回 cwd
      if (ws) payload.workspaceId = ws.workspaceId
      else payload.cwd = target
    }

    const res = await this.client.call<{ sessionId: string }>('session.create', payload)
    if (!res.ok) {
      console.error('[store] 建会话失败', res.error)
      return
    }
    await this.syncList()
    await this.open(res.value.sessionId)
  }

  /** 从已有会话的 cwd 聚合出「最近工作区」（session.list 是扁平列表，没有工作区树） */
  recentCwds(): string[] {
    const seen = new Map<string, number>()
    for (const s of this.summaries.values()) {
      if (!s.cwd) continue
      seen.set(s.cwd, Math.max(seen.get(s.cwd) ?? 0, s.updatedAt))
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }

  async answerInbox(itemId: string, answer: InboxAnswer): Promise<void> {
    const item = this.inbox.get(itemId)
    if (!item) return
    const payload =
      answer.kind === 'approval'
        ? { sessionId: item.sessionId, approvalId: item.id, outcome: answer.outcome }
        : {
            sessionId: item.sessionId,
            answer: {
              answers: [{ id: item.questions?.[0]?.id ?? 'q', selected: answer.selected,
                          ...(answer.custom ? { custom: answer.custom } : {}) }],
            },
          }
    const res = await this.client.respond(item.id, payload)
    if (!res.ok) console.error('[store] 应答失败', res.error)
    this.inbox.delete(itemId)
    this.notify(0)
  }

  /* ---- 会话增删改查（对齐 dsh 原生侧边栏的能力）---- */

  /**
   * 找一个能吃掉图片的模型。
   * dsh 不把 inputModalities 暴露在 catalog 里（见方案 §16），所以只能按名字找视觉模型，
   * 真正的判定交给服务端 —— 发失败了再切。
   */
  private findVisionModel(): { provider: string; id: string } | null {
    for (const g of this.catalog?.groups ?? []) {
      for (const m of g.models ?? []) {
        if (/vision/i.test(m.id) || /vision/i.test(m.name ?? '')) return { provider: g.id, id: m.id }
      }
    }
    return null
  }

  private refreshCatalogView(): void {
    const cur = this.model
    this.catalogView = {
      current: cur ? { ...cur } : { provider: '', model: '' },
      groups: (this.catalog?.groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        models: (g.models ?? []).map((m) => {
          const anyM = m as unknown as { reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string } }
          return {
            id: m.id,
            name: m.name ?? m.id,
            efforts: anyM.reasoning?.efforts,
            defaultEffort: anyM.reasoning?.defaultEffort,
          }
        }),
      })),
    }
  }

  private async refreshCatalog(): Promise<void> {
    if (!this.currentId) return
    const m = await this.client.value<{
      current?: { provider: string; model: string; reasoningEffort?: string }
      groups?: ModelGroup[]
    }>('session.models', { sessionId: this.currentId })
    if (m?.current) {
      this.model = m.current
      this.catalog = { groups: m.groups }
      this.refreshCatalogView()
      this.notify(0)
    }
  }

  async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    if (!this.currentId) return
    const payload: Record<string, unknown> = { sessionId: this.currentId, provider, model }
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort
    const res = await this.client.call<{ selected?: { provider: string; model: string; reasoningEffort?: string } }>('session.selectModel', payload)
    if (!res.ok) {
      console.error('[store] 切模型失败', res.error)
      return
    }
    if (res.value?.selected) this.model = res.value.selected
    else this.model = { provider, model, reasoningEffort }
    this.refreshCatalogView()
    this.notify(0)
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const res = await this.client.call('session.rename', { sessionId, title })
    if (!res.ok) { console.error('[store] 重命名失败', res.error); return }
    const s = this.summaries.get(sessionId)
    if (s) s.title = title
    this.notify(0)
  }

  async archiveSession(sessionId: string): Promise<void> {
    const res = await this.client.call<{ archivedSessionIds: string[] }>('workspace.archiveSession', { sessionId })
    if (!res.ok) { console.error('[store] 归档失败', res.error); return }
    this.archived.clear()
    for (const id of res.value?.archivedSessionIds ?? []) this.archived.add(id)
    // 归档掉的是当前会话 → 自动切到下一个可见会话
    if (this.currentId === sessionId) {
      const next = [...this.summaries.values()]
        .filter((x) => !x.isSubagent && !this.archived.has(x.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (next) await this.open(next.sessionId)
      else { this.currentId = null; this.client.followSession(null) }
    }
    this.notify(0)
  }

  async forkSession(sessionId: string): Promise<void> {
    const res = await this.client.call<{ sessionId: string }>('session.fork', { sessionId })
    if (!res.ok) { console.error('[store] 分叉失败', res.error); return }
    await this.syncList()
    await this.open(res.value.sessionId)
  }

  /* ---- 工作区 ---- */

  async addWorkspace(): Promise<void> {
    const picked = await this.client.value<string | { path?: string }>('host.pickDirectory', {})
    const path = typeof picked === 'string' ? picked : picked?.path
    if (!path) return
    const res = await this.client.call('workspace.create', { path })
    if (!res.ok) { console.error('[store] 添加工作区失败', res.error); return }
    await this.syncList()
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    if (!title.trim()) return
    const res = await this.client.call('workspace.rename', { workspaceId, title })
    if (!res.ok) { console.error('[store] 重命名工作区失败', res.error); return }
    await this.syncList()
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const res = await this.client.call('workspace.delete', { workspaceId })
    if (!res.ok) { console.error('[store] 删除工作区失败', res.error); return }
    await this.syncList()
  }

  /* ---- 模型密钥（DEEPSEEK_API_KEY）---- */

  /** 探测某个密钥是否已配置（ref 是环境变量形式的名字） */
  async credentialConfigured(ref: string): Promise<{ configured: boolean; writable: boolean }> {
    const r = await this.client.value<{ credentials?: Record<string, { configured: boolean; writable: boolean }> }>(
      'credentials.describe', { refs: [ref] })
    const v = r?.credentials?.[ref]
    return { configured: v?.configured === true, writable: v?.writable !== false }
  }

  /** 写入密钥。只在这一个方向上传值，绝不回读。 */
  async setCredential(ref: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.client.call('credentials.set', { ref, value })
    return res.ok ? { ok: true } : { ok: false, error: res.error.message }
  }

  /* ---- 快照 ---- */

  snapshot(): Snapshot {
    const list = [...this.summaries.values()]
    const visible = list.filter((s) => !this.archived.has(s.sessionId))
    const mains = visible.filter((s) => !s.isSubagent)
    mains.sort((a, b) => b.updatedAt - a.updatedAt)
    const subagentCount = visible.length - mains.length

    let current: SessionView | null = null
    if (this.currentId) {
      const rec = this.ensure(this.currentId)
      const rows = [...rec.rows]
      if (rec.liveText) {
        rows.push({ kind: 'assistant', id: 'live', text: rec.liveText, time: Date.now(), streaming: true })
      }
      current = {
        sessionId: rec.sessionId,
        title: this.titleOf(rec.sessionId),
        cwd: this.summaries.get(rec.sessionId)?.cwd,
        running: rec.running,
        rows,
        loaded: rec.loaded,
        loading: rec.loading,
        error: rec.error,
        hasMore: rec.hasMore,
        tokens: rec.tokens,
        context: rec.context,
        permissions: this.summaries.get(rec.sessionId)?.permissions ?? rec.permissions,
      }
    }

    // 状态徽标派生（对齐 dsh 侧边栏的 7 种状态，取我们拿得到的几种）
    const inboxBySession = new Map<string, InboxItem[]>()
    for (const item of this.inbox.values()) {
      const list = inboxBySession.get(item.sessionId) ?? []
      list.push(item)
      inboxBySession.set(item.sessionId, list)
    }
    const withStatus = mains.map((s) => {
      const items = inboxBySession.get(s.sessionId) ?? []
      let status: SessionStatus = 'idle'
      if (s.running) status = 'running'
      else if (items.some((i) => i.kind === 'approval')) status = 'waitingApproval'
      else if (items.some((i) => i.kind === 'question')) status = 'waitingAnswer'
      const kids = visible.filter((x) => x.parentSessionId === s.sessionId && x.running).length
      return { ...s, status, subagentsRunning: kids || undefined }
    })

    return {
      bus: this.busState,
      sessions: withStatus,
      workspaces: this.workspaces,
      subagentCount,
      current,
      inbox: [...this.inbox.values()],
      catalog: this.catalogView,
    }
  }

  getCurrentId(): string | null {
    return this.currentId
  }
}