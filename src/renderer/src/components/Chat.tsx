import { Fragment, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react'
import type {
  Attachment, BubbleConfig, BubbleState, ChatRow, FormFactor, MonitorMode, PerceptionView, Snapshot,
} from '@shared/types'
import { FORM_SIZES, MONITOR_LABELS } from '@shared/types'
import { Markdown } from './Markdown'
import { InboxBar } from './InboxBar'
import { SessionSidebar } from './SessionSidebar'

const FORM_LABEL: Record<FormFactor, string> = { capsule: '胶囊', bubble: '气泡', panel: '面板' }

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

function toolIcon(name: string): string {
  if (/read|cat|file/.test(name)) return '📄'
  if (/edit|write|replace/.test(name)) return '✎'
  if (/grep|glob|search/.test(name)) return '🔍'
  if (/pwsh|bash|code|shell/.test(name)) return '⌨'
  if (/web|fetch/.test(name)) return '🌐'
  return '⚙'
}

async function fileToBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
  return btoa(bin)
}

export function Chat({
  snap, state, config, perception, onOpenSettings, onOpenLink, onCopy,
}: {
  snap: Snapshot | null
  state: BubbleState
  config: BubbleConfig | null
  perception: PerceptionView | null
  onOpenSettings: () => void
  onOpenLink: (url: string) => void
  onCopy: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [attach, setAttach] = useState<Attachment[]>([])
  const [pop, setPop] = useState<null | 'cap' | 'file' | 'more' | 'model' | 'effort' | 'mon'>(null)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowCount = snap?.current?.rows.length ?? 0

  const bus = snap?.bus
  const cur = snap?.current
  const ready = bus?.state === 'ready'
  const running = Boolean(cur?.running)
  const inboxCount = snap?.inbox.length ?? 0
  const sidebarOpen = state.sidebarOpen
  const chatWidth = state.bounds.width - (sidebarOpen ? 260 : 0)
  const wide = chatWidth >= 560

  /*
   * 滚动策略：
   *   pinned = 用户是否「贴着底部」。
   *   切会话 → 强制回到底部（看最新消息）；此后只有贴着底部才跟随新消息，
   *   用户主动往上翻时不会被拽下来。
   */
  const pinned = useRef(true)
  const sessionId = snap?.current?.sessionId

  useEffect(() => {
    pinned.current = true // 切会话 = 一定落到最新消息
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  /*
   * 每次渲染后都尝试贴底。
   * **必须用 rAF**：effect 执行时 React 刚提交 DOM，而列表内容（长文本、表格、
   * 图片）会把 scrollHeight 在随后几帧里继续撑大 —— 实测 effect 里读到的是
   * scrollHeight === clientHeight，此时写 scrollTop 会被钳成 0，看起来就是「没滚」。
   * rAF 等到布局完成后再写，才能真正落到最新消息。
   */
  useEffect(() => {
    if (!pinned.current) return
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  })

  /**
   * 点空白处 / 按 Esc 关闭弹层。
   *
   * 原来**根本没有这个处理** —— 弹层只能靠再点一次触发按钮才关得掉，
   * 点别处一律没反应，用户会以为界面卡住了。
   *
   * 用 pointerdown 而不是 click：按下就关，手感跟系统菜单一致。
   */
  useEffect(() => {
    if (pop === null) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('.pop')) return            // 点在弹层内部 → 不关
      if (t.closest('.b2, .ic, .add, .chipbtn')) return  // 点触发按钮 → 交给它自己 toggle
      setPop(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPop(null) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pop])

  useEffect(() => window.bubble.onAttachStaged((items) => {
    setAttach((prev) => [...prev, ...items])
    setPop(null)
  }), [])

  /* ---- 粘贴 / 拖拽：同一套逻辑 ---- */
  const importFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    try {
      const paths: string[] = []
      const bytes: Array<{ name: string; base64: string }> = []
      for (const f of files) {
        const p = window.bubble.pathForFile(f)
        if (p) paths.push(p)
        else bytes.push({ name: f.name || 'pasted.png', base64: await fileToBase64(f) })
      }
      const added: Attachment[] = []
      if (paths.length) added.push(...(await window.bubble.classifyPaths(paths)))
      for (const b of bytes) {
        const a = await window.bubble.attachFromBytes(b.name, b.base64)
        if (a) added.push(a)
      }
      if (added.length) setAttach((prev) => [...prev, ...added])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onPaste = (e: Event): void => {
      const ce = e as unknown as ReactClipboardEvent
      const files = Array.from(ce.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      void importFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) void importFiles(files)
  }

  const send = (): void => {
    const text = draft.trim()
    if ((!text && attach.length === 0) || !ready) return
    const items = attach
    setDraft('')
    setAttach([])
    void window.bubble.prompt(text, items)
  }

  const cap = async (mode: 'screen' | 'region'): Promise<void> => {
    setPop(null)
    setBusy(true)
    try {
      const img = mode === 'screen' ? await window.bubble.captureScreen() : await window.bubble.captureRegion()
      if (img) {
        const a = await window.bubble.attachFromBytes('screenshot.jpg', img.base64)
        if (a) {
          setAttach((prev) => [...prev, { ...a, label: img.label, sourceWidth: img.sourceWidth, sourceHeight: img.sourceHeight } as Attachment])
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    setPop(null)
    const items = await window.bubble.pickFiles()
    if (items.length) setAttach((prev) => [...prev, ...items])
  }

  const nextForm: FormFactor = state.form === 'capsule' ? 'bubble' : state.form === 'bubble' ? 'panel' : 'capsule'
  const mon: MonitorMode = perception?.mode ?? 'off'
  const setMon = (m: MonitorMode): void => {
    setPop(null)
    void window.bubble.setMonitorMode(m)
  }
  const cat = snap?.catalog
  const curModel = cat?.groups.flatMap((g) => g.models.map((m) => ({ g, m }))).find((x) => x.m.id === cat.current.model)

  return (
    <>
      {sidebarOpen && snap ? <SessionSidebar snap={snap} /> : null}

      <div className="chatwrap">
        <div className="hdr2" style={{ height: wide ? 48 : 44 }}>
          <div className="grp">
            <button className={'b2' + (sidebarOpen ? ' on' : '')} title="会话列表"
              onClick={() => void window.bubble.setSidebarOpen(!sidebarOpen)}>
              <span>☰</span>{wide ? <span className="lbl">会话</span> : null}
            </button>
            <button className="b2" title="新建会话" onClick={() => void window.bubble.createSession()}>
              <span>＋</span>{wide ? <span className="lbl">新建</span> : null}
            </button>
          </div>
          <div className="sepv" />
          <div className="name" style={wide ? { justifyContent: 'flex-start', paddingLeft: 12 } : undefined}>
            <span className="nm">{cur?.title ?? (bus?.state === 'starting' ? '启动中…' : '未连接')}</span>
            {running ? <span className="dot" /> : null}
          </div>
          <div className="grp">
            <button
              className={'b2' + (pop === 'mon' ? ' on' : '') + (mon !== 'off' ? ' live' : '')}
              title={'屏幕共享：' + MONITOR_LABELS[mon].name}
              onClick={() => setPop(pop === 'mon' ? null : 'mon')}
            >
              <span>🖥</span>{wide ? <span className="lbl">共享</span> : null}
            </button>
            <button className={'b2' + (pop === 'cap' ? ' on' : '')} title="截图提问" onClick={() => setPop(pop === 'cap' ? null : 'cap')}>
              <span>📷</span>{wide ? <span className="lbl">截图</span> : null}
            </button>
            <button
              className={'b2' + (state.alwaysOnTop ? ' pin-on' : '')}
              title={state.alwaysOnTop ? '已置顶（点击取消）' : '未置顶（点击置顶）'}
              onClick={() => void window.bubble.setAlwaysOnTop(!state.alwaysOnTop)}
            >
              <span>📌</span>{wide ? <span className="lbl">置顶</span> : null}
            </button>
            <button className={'b2' + (pop === 'more' ? ' on' : '')} title="更多" onClick={() => setPop(pop === 'more' ? null : 'more')}><span>⋯</span></button>
            <button
              className="b2 b-close"
              title={config?.closeToTray !== false ? '关闭（收进托盘，程序继续运行）' : '关闭（退出程序）'}
              onClick={() => window.bubble.close()}
            >
              <span>✕</span>
            </button>
          </div>
        </div>

        {pop === 'cap' ? (
          <div className="pop" style={{ right: 10, top: wide ? 54 : 50, width: 246 }}>
            <div className="row" onClick={() => void cap('region')}><div className="t">框选区域<small>只截你要问的那块，最省 token</small></div></div>
            <div className="row" onClick={() => void cap('screen')}><div className="t">整个屏幕<small>跨屏看整体情况</small></div></div>
          </div>
        ) : null}

        {pop === 'file' ? (
          <div className="pop" style={{ left: 10, bottom: 84, width: 248 }}>
            <div className="row" onClick={() => void pick()}><div className="t">📄 选择文件…<small>文本内联 · 图片压缩 · 其他只发路径</small></div></div>
            <div className="row" onClick={() => void cap('region')}><div className="t">📷 截图<small>框选一块屏幕</small></div></div>
            <div className="row"><div className="t">📋 粘贴 / 拖拽<small>Ctrl+V 或直接把文件拖进来</small></div></div>
          </div>
        ) : null}

        {pop === 'mon' ? (
          <div className="pop" style={{ right: 10, top: wide ? 54 : 50, width: 268 }}>
            <div className="hd">屏幕共享</div>
            {(['off', 'passive'] as MonitorMode[]).map((m) => (
              <div key={m} className={'row' + (mon === m ? ' sel' : '')} onClick={() => setMon(m)}>
                <div className="t">{MONITOR_LABELS[m].name}<small>{MONITOR_LABELS[m].desc}</small></div>
                {mon === m ? <span className="ck">✓</span> : null}
              </div>
            ))}
            {perception ? (
              <>
                <div className="sep" />
                <div className="perception-sum">
                  采样 {perception.samples} 次 · 变化 {perception.changes} 次<br />
                  本地日记 {perception.diary.length} 条 · 已上传 {perception.uploadedFrames} 帧 · ≈{perception.estTokens} tok
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {pop === 'more' ? (
          <div className="pop" style={{ right: 8, top: wide ? 54 : 50, width: 196, zIndex: 61 }}>
            <div className="row" onClick={() => { setPop(null); void window.bubble.setForm(nextForm) }}>
              <div className="t">⤢ 切换到{FORM_LABEL[nextForm]}<small>{FORM_SIZES[nextForm].width}×{FORM_SIZES[nextForm].height}</small></div>
            </div>
            <div className="row" onClick={() => { setPop(null); window.bubble.hide() }}><div className="t">🗕 收进托盘<small>程序继续在后台运行</small></div></div>
            <div className="row" onClick={() => { setPop(null); void window.bubble.quit() }}><div className="t">⏻ 退出程序<small>彻底结束后台</small></div></div>
            <div className="row" onClick={() => { setPop(null); onOpenSettings() }}><div className="t">⚙ 设置</div></div>
            <div className="row" onClick={() => { setPop(null); void window.bubble.refresh() }}><div className="t">🔄 刷新会话列表</div></div>
          </div>
        ) : null}

        {snap ? <InboxBar snap={snap} /> : null}

        <div className="msgs" ref={scrollRef}>
          {bus?.state === 'error' ? (
            <div className="empty-hint">⚠ 连不上 dsh<br />{bus.detail ?? ''}</div>
          ) : !cur || cur.loading ? (
            <div className="empty-hint">载入中…</div>
          ) : cur.error ? (
            <div className="empty-hint">读取会话失败<br />{cur.error}</div>
          ) : cur.rows.length === 0 ? (
            <div className="empty-hint">这个会话还没有消息<br />在下面直接问点什么</div>
          ) : (
            cur.rows.map((r, i) => (
              <Fragment key={r.id + ':' + i}>
                <Row row={r} markdown={config?.markdown !== false} onLink={onOpenLink} onCopy={onCopy} />
              </Fragment>
            ))
          )}
        </div>

        <div className="cmp">
          {attach.length ? (
            <div className="strip">
              {attach.map((a) => (
                <div key={a.id} className={'atch' + (a.kind === 'image' ? ' img' : '')}
                  title={a.kind === 'path' ? a.path : a.name}>
                  {a.kind === 'image' ? (
                    <img src={'data:' + a.mediaType + ';base64,' + a.base64} alt={a.name} />
                  ) : a.kind === 'text' ? '📄' : '📁'}
                  {a.kind === 'image' ? <span className="tag">{a.width}×{a.height}</span> : null}
                  <span className="x" onClick={() => setAttach((prev) => prev.filter((x) => x.id !== a.id))}>✕</span>
                </div>
              ))}
              <button className="add" onClick={() => setPop('file')}>＋</button>
            </div>
          ) : null}
          {attach.length ? (
            <div className="stripinfo">{attach.length} 个附件 · {attach.map((a) => a.kind === 'image' ? a.name : a.kind === 'text' ? a.name + '（内联）' : a.name + '（仅路径）').join(' · ')}</div>
          ) : null}

          <div className="box">
            <input
              value={draft}
              placeholder={busy ? '正在处理…' : attach.length ? '对这些附件问点什么…' : ready ? '问点什么…' : '等待 dsh 连接…'}
              disabled={!ready}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            />
            <button className={'ic' + (pop === 'file' ? ' on' : '')} title="上传文件 / 截图" onClick={() => setPop(pop === 'file' ? null : 'file')}>📎</button>
            {running ? (
              <button className="stop" title="中止" onClick={() => void window.bubble.cancel()}>■</button>
            ) : (
              <button className="send" onClick={send} disabled={(!draft.trim() && attach.length === 0) || !ready} title="发送">↑</button>
            )}
          </div>

          <div className="sub">
            <span className="chipwrap">
              <span className={'chipbtn' + (pop === 'model' ? ' on' : '')} onClick={() => setPop(pop === 'model' ? null : 'model')}>
                ⚙ <b>{cat?.current.model ?? '—'}</b>
              </span>
              {pop === 'model' && cat ? (
                <div className="pop anchored" style={{ width: 240, maxHeight: 320, overflowY: 'auto' }}>
                  <div className="hd">模型</div>
                  {cat.groups.map((g) =>
                    g.models.map((m) => (
                      <div key={g.id + '/' + m.id} className={'row' + (m.id === cat.current.model ? ' sel' : '')}
                        onClick={() => { setPop(null); void window.bubble.selectModel(g.id, m.id, cat.current.reasoningEffort) }}>
                        <div className="t">{m.name}<small>{g.name}</small></div>
                        {m.id === cat.current.model ? <span className="ck">✓</span> : null}
                      </div>
                    )),
                  )}
                </div>
              ) : null}
            </span>
            <span className="chipwrap">
              <span className={'chipbtn' + (pop === 'effort' ? ' on' : '')} onClick={() => setPop(pop === 'effort' ? null : 'effort')}>
                思考 <b>{effortLabel(cat?.current.reasoningEffort)}</b>
              </span>
              {pop === 'effort' && cat ? (
                <div className="pop anchored" style={{ width: 170 }}>
                  <div className="hd">思考模式</div>
                  {(curModel?.m.efforts ?? [{ id: 'high', name: '高' }]).map((e) => (
                    <div key={e.id} className={'row' + (e.id === cat.current.reasoningEffort ? ' sel' : '')}
                      onClick={() => { setPop(null); void window.bubble.selectModel(cat.current.provider, cat.current.model, e.id) }}>
                      <div className="t">{e.name}</div>
                      {e.id === cat.current.reasoningEffort ? <span className="ck">✓</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </span>
            <span className="right" />
          </div>

        </div>

        <div className="sb">
          {/* 连接正常时不占地方；只在启动中/断开这种需要用户知情的时候才出现 */}
          {bus?.state !== 'ready' ? (
            <span className={bus?.state === 'error' ? 'bus-err' : undefined}>
              {bus?.state === 'starting' ? '● 启动中' : '● 未连接'}
            </span>
          ) : null}
          <span className={mon === 'off' ? undefined : 's'}>
            {mon === 'off' ? '共享关闭' : mon === 'passive' ? '仅感知' : '感知中'}
          </span>
          {mon !== 'off' && perception ? <span>{perception.changes} 变 · {perception.estTokens} tok</span> : null}
          <span className="right">
            {cur?.tokens ? '↑' + fmt(cur.tokens.input) + ' ↓' + fmt(cur.tokens.output) : ''}
            {cur?.context && cur.context.window ? '  ' + Math.round((cur.context.used / cur.context.window) * 100) + '%' : ''}
            {inboxCount ? '  📥' + inboxCount : ''}
          </span>
        </div>
      </div>

      {dropping ? (
        <div className="drop" onDragLeave={() => setDropping(false)} onDrop={onDrop}>
          <div className="inner">
            <div className="big">📥</div>
            <div className="t1">松开以添加文件</div>
            <div className="t2">图片压缩后发送 · 文本内联 · 其他只发路径</div>
          </div>
        </div>
      ) : null}

      {/* 拖拽进入整窗的探测层 */}
      <div
        className="dropzone"
        onDragOver={(e) => { e.preventDefault(); if (!dropping) setDropping(true) }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
        onDrop={onDrop}
      />
    </>
  )
}

function effortLabel(id?: string): string {
  if (id === 'off') return '关'
  if (id === 'low') return '低'
  if (id === 'max') return '最高'
  if (id === 'high') return '高'
  return id ?? '—'
}

function Row({ row, markdown, onLink, onCopy }: {
  row: ChatRow; markdown: boolean; onLink: (u: string) => void; onCopy: (t: string) => void
}) {
  const [openReason, setOpenReason] = useState(false)
  switch (row.kind) {
    case 'user':
      return (
        <div className="msg me">
          {row.attachCount ? <span className="imgtag">{row.hasImage ? '🖼' : '📎'} {row.attachCount}</span> : null}
          {row.text}
        </div>
      )
    case 'assistant':
      return (
        <>
          {row.reasoning ? (
            <div className="reason" onClick={() => setOpenReason((v) => !v)}>
              <span className="h">{openReason ? '▾' : '▸'} 思考</span>
              {openReason
                ? <div style={{ marginTop: 4 }}>{row.reasoning}</div>
                : <span> {row.reasoning.replace(/\s+/g, ' ').slice(0, 46)}…</span>}
            </div>
          ) : null}
          {row.text ? (
            <div className="msg ai">
              {markdown ? <Markdown text={row.text} onLink={onLink} onCopy={onCopy} /> : row.text}
              {row.streaming ? <span className="cur" /> : null}
            </div>
          ) : null}
        </>
      )
    case 'tool':
      return (
        <div className={'tool' + (row.status === 'error' ? ' err' : '')} title={row.preview}>
          <span className="head">{toolIcon(row.name)} {row.name}{row.status === 'running' ? ' …' : row.status === 'error' ? ' ✕' : ' ✓'}</span>
          {row.preview ? <span className="pv">{row.preview}</span> : null}
        </div>
      )
    default:
      return <div className="notice">{row.text}</div>
  }
}