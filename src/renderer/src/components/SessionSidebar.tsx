import { useMemo, useRef, useState } from 'react'
import type { SessionSummary, Snapshot, WorkspaceSummary } from '@shared/types'

type GroupBy = 'workspace' | 'flat'
type OrderBy = 'updated' | 'created'

function ago(ts: number): string {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 时'
  const day = Math.floor(h / 24)
  if (day < 30) return day + ' 天'
  return Math.floor(day / 30) + ' 月'
}

const STATUS_CLASS: Record<string, string> = {
  running: 'run',
  waitingApproval: 'wait',
  waitingAnswer: 'wait',
  planReview: 'wait',
  idle: 'idle',
  completed: 'idle',
}

export function SessionSidebar({ snap }: { snap: Snapshot }) {
  const [q, setQ] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('workspace')
  const [orderBy, setOrderBy] = useState<OrderBy>('updated')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'session' | 'workspace'; id: string } | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? snap.sessions.filter(
          (s) => s.title.toLowerCase().includes(needle) || (s.cwd ?? '').toLowerCase().includes(needle),
        )
      : snap.sessions
    return [...list].sort((a, b) =>
      orderBy === 'updated' ? b.updatedAt - a.updatedAt : (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt),
    )
  }, [snap.sessions, q, orderBy])

  /** 按工作区归组；不在任何工作区里的落到「未分组」 */
  const groups = useMemo(() => {
    if (groupBy === 'flat') return [{ ws: null as WorkspaceSummary | null, items: filtered }]
    const byId = new Map(snap.sessions.map((s) => [s.sessionId, s]))
    const used = new Set<string>()
    const out: Array<{ ws: WorkspaceSummary | null; items: SessionSummary[] }> = []
    for (const w of snap.workspaces) {
      const items: SessionSummary[] = []
      for (const id of w.sessionIds) {
        const s = byId.get(id)
        if (s && !used.has(id)) { items.push(s); used.add(id) }
      }
      out.push({ ws: w, items })
    }
    const rest = filtered.filter((s) => !used.has(s.sessionId))
    if (rest.length) out.push({ ws: null, items: rest })
    return out.filter((g) => g.items.length > 0 || !q.trim())
  }, [snap.workspaces, snap.sessions, filtered, groupBy, q])


  const startRename = (kind: 'session' | 'workspace', id: string, initial: string): void => {
    setMenuFor(null)
    setRenaming({ kind, id })
    setDraft(initial)
    setTimeout(() => inputRef.current?.select(), 30)
  }
  const commitRename = (): void => {
    if (!renaming) return
    const title = draft.trim()
    if (title) {
      if (renaming.kind === 'session') void window.bubble.renameSession(renaming.id, title)
      else void window.bubble.renameWorkspace(renaming.id, title)
    }
    setRenaming(null)
  }

  const currentId = snap.current?.sessionId

  const renderSession = (s: SessionSummary) => {
    if (renaming?.kind === 'session' && renaming.id === s.sessionId) {
      return (
        <div className="sess" key={s.sessionId}>
          <input
            ref={inputRef}
            className="srename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={commitRename}
          />
        </div>
      )
    }
    return (
      <div
        key={s.sessionId}
        className={'sess' + (s.sessionId === currentId ? ' a' : '')}
        title={(s.cwd ?? '') + '\n' + new Date(s.updatedAt).toLocaleString()}
        onClick={() => void window.bubble.openSession(s.sessionId)}
      >
        <span className={'st ' + (STATUS_CLASS[s.status ?? 'idle'] ?? 'idle')} />
        <span className="nm">{s.title}</span>
        {s.subagentsRunning ? <span className="kid">⑂{s.subagentsRunning}</span> : null}
        <small>{ago(s.updatedAt)}</small>
        <button
          className="smore"
          title="更多操作"
          onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.sessionId ? null : s.sessionId) }}
        >
          ⋯
        </button>
        {menuFor === s.sessionId ? (
          <div className="smenu" onClick={(e) => e.stopPropagation()}>
            <div onClick={() => startRename('session', s.sessionId, s.title)}>✎ 重命名</div>
            <div onClick={() => { setMenuFor(null); void window.bubble.forkSession(s.sessionId) }}>⑂ 分叉会话</div>
            <div onClick={() => { setMenuFor(null); void window.bubble.archiveSession(s.sessionId) }}>🗄 归档会话</div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="side">
      <div className="s1">
        <div className="sbox">
          <span>🔍</span>
          <input value={q} placeholder="搜索会话…" onChange={(e) => setQ(e.target.value)} />
          {q ? <span className="clr" onClick={() => setQ('')}>✕</span> : null}
        </div>
      </div>

      <div className="sopt">
        <div className={'ochip' + (groupBy === 'workspace' ? ' a' : '')} onClick={() => setGroupBy('workspace')}>按工作区</div>
        <div className={'ochip' + (groupBy === 'flat' ? ' a' : '')} onClick={() => setGroupBy('flat')}>单列表</div>
      </div>
      <div className="sopt">
        <div className={'ochip' + (orderBy === 'updated' ? ' a' : '')} onClick={() => setOrderBy('updated')}>最近更新</div>
        <div className={'ochip' + (orderBy === 'created' ? ' a' : '')} onClick={() => setOrderBy('created')}>创建时间</div>
      </div>

      <div className="tree">
        {groups.length === 0 ? <div className="sempty">没有匹配的会话</div> : null}
        {groups.map((g) => {
          const key = g.ws ? g.ws.workspaceId : '__ungrouped__'
          return (
            <div key={key}>
              <div className="grp">
                <span className="ar">▼</span>
                {renaming?.kind === 'workspace' && renaming.id === (g.ws?.workspaceId ?? '') ? (
                  <input
                    ref={inputRef}
                    className="srename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="gt" title={g.ws?.path ?? ''}>{g.ws ? g.ws.title : '未分组'}</span>
                )}
                <span className="n">{g.items.length}</span>
                {g.ws ? (
                  <div className="wmenu">
                    <button className="smore" title="工作区操作" onClick={() => setMenuFor(menuFor === key ? null : key)}>⋯</button>
                    {menuFor === key ? (
                      <div className="smenu" style={{ left: 'auto', right: 8 }}>
                        <div onClick={() => startRename('workspace', g.ws!.workspaceId, g.ws!.title)}>✎ 重命名工作区</div>
                        <div onClick={() => { setMenuFor(null); void window.bubble.removeWorkspace(g.ws!.workspaceId) }}>🗑 删除工作区</div>
                        <div onClick={() => { setMenuFor(null); void window.bubble.createSession(g.ws!.path) }}>＋ 在此新建会话</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {g.items.map(renderSession)}
            </div>
          )
        })}
      </div>

      <div className="ft2" onClick={() => void window.bubble.addWorkspace()}>＋ 添加工作区…</div>
    </div>
  )
}
