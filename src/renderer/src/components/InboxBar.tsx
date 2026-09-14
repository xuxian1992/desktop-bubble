import type { Snapshot } from '@shared/types'

/** 跨会话收件箱：不管哪个会话在等你回答，都在这里提醒 */
export function InboxBar({ snap }: { snap: Snapshot }) {
  const item = snap.inbox[0]
  if (!item) return null
  const q = item.questions?.[0]

  return (
    <div className="inbox">
      <div className="t">
        {item.kind === 'approval' ? '⚠ 有工具在等待授权' : '❓ 有会话在等你回答'}
        <span style={{ opacity: 0.7 }}> · {item.sessionTitle}</span>
      </div>

      {item.kind === 'approval' ? (
        <div className="q">
          工具 <code>{item.toolName}</code>
          {item.reason ? ' —— ' + item.reason : ''}
        </div>
      ) : (
        <div className="q">{q?.question ?? '(问题内容缺失)'}</div>
      )}

      <div className="acts">
        {item.kind === 'approval' ? (
          <>
            <button className="pri" onClick={() => void window.bubble.answerInbox(item.id, { kind: 'approval', outcome: 'allowed-once' })}>允许一次</button>
            <button onClick={() => void window.bubble.answerInbox(item.id, { kind: 'approval', outcome: 'rejected' })}>拒绝</button>
          </>
        ) : (
          <>
            {(q?.options ?? []).slice(0, 3).map((o) => (
              <button key={o.label} onClick={() => void window.bubble.answerInbox(item.id, { kind: 'question', selected: [o.label] })}>
                {o.label}
              </button>
            ))}
            {!q?.options?.length && (
              <button className="pri" onClick={() => void window.bubble.answerInbox(item.id, { kind: 'question', selected: ['继续'] })}>继续</button>
            )}
          </>
        )}
        <button onClick={() => void window.bubble.openSession(item.sessionId)}>跳到该会话</button>
      </div>
    </div>
  )
}
