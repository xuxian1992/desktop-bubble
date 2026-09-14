import { useMemo, useState } from 'react'
import type { Snapshot } from '@shared/types'

function ago(ts: number): string {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

/** 会话切换面板：本地模糊搜索（dsh 的 session.search 在本机被禁用，见方案 §13.2 C3） */
export function SessionSwitcher({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [q, setQ] = useState('')
  const cwds = useMemo(() => {
    const seen = new Map<string, number>()
    for (const s of snap.sessions) if (s.cwd) seen.set(s.cwd, Math.max(seen.get(s.cwd) ?? 0, s.updatedAt))
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [snap.sessions])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return snap.sessions
    return snap.sessions.filter(
      (s) => s.title.toLowerCase().includes(needle) || (s.cwd ?? '').toLowerCase().includes(needle),
    )
  }, [snap.sessions, q])

  const currentId = snap.current?.sessionId
  const pending = new Set(snap.inbox.map((i) => i.sessionId))

  return (
    <div className="sw">
      <div className="srch">
        <span style={{ color: '#6e7686' }}>🔍</span>
        <input autoFocus value={q} placeholder="搜索会话…" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips">
        <span className="chip a">全部 {snap.sessions.length}</span>
        {snap.subagentCount > 0 && <span className="chip">已折叠子会话 {snap.subagentCount}</span>}
      </div>
      <div className="list">
        {list.length === 0 && <div className="empty">没有匹配的会话</div>}
        {list.slice(0, 60).map((s) => (
          <div
            key={s.sessionId}
            className={'item' + (s.sessionId === currentId ? ' a' : '')}
            onClick={() => {
              void window.bubble.openSession(s.sessionId)
              onClose()
            }}
          >
            <span className={'rd' + (s.running ? ' run' : pending.has(s.sessionId) ? ' bad' : '')} />
            <span className="nm">{s.title}</span>
            <small>{ago(s.updatedAt)}</small>
          </div>
        ))}
      </div>
      <div className="ft">
        <b onClick={() => { void window.bubble.createSession(cwds[0]); onClose() }}>＋ 新建会话</b>
        <span className="cwd">{cwds[0] ? '最近工作区 ' + cwds[0] : '无工作区'}</span>
      </div>
    </div>
  )
}
