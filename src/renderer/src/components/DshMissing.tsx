import { useEffect, useState } from 'react'

/**
 * 「没有 dsh」这条消息 —— 它是一条**对话**，不是一个状态条。
 *
 * 为什么放在聊天流里而不是加一条横幅：
 *   · 缺 dsh 的本质是「我现在没法跟你说话」，那是**助手说的一句话**
 *   · 按钮长在消息上，用户不用去别处找
 *   · 不额外占用界面 —— 聊天区本来就有位置（原来那里写着「连不上 dsh」）
 *
 * 装的过程也在这条消息里实时更新，装完就地变成「开始使用」。用户全程不用离开这里。
 */

type Phase = 'idle' | 'installing' | 'done' | 'error'

export function DshMissing({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    const offLine = window.bubble.onDshInstallLine((l) => setLog((p) => [...p.slice(-24), l]))
    const offDone = window.bubble.onDshInstallDone((r) => {
      setLog((p) => [...p, r.detail])
      setPhase(r.ok ? 'done' : 'error')
    })
    return () => { offLine(); offDone() }
  }, [])

  const install = (): void => {
    setLog([])
    setPhase('installing')
    void window.bubble.installDsh()
  }

  return (
    <div className="msg ai dshmiss-msg">
      {phase === 'idle' ? (
        <>
          <p className="dm-lead">
            我还没法回你话 —— 这台机器上没有 <b>dsh</b>（DeepSeek Harness）。
          </p>
          <p className="dm-sub">
            气泡本身只是个壳，真正干活的大脑是 dsh。装好它我才能接上话。
          </p>
          <div className="dm-acts">
            <button className="dm-pri" onClick={install}>帮我安装 dsh</button>
            <button className="dm-sec" onClick={onReady}>我自己装好了，重新检测</button>
          </div>
          <p className="dm-note">约 200 MB，走你本机的 npm，可能要几分钟</p>
        </>
      ) : null}

      {phase === 'installing' ? (
        <>
          <p className="dm-lead">正在装 dsh…</p>
          <pre className="dm-log">{log.join('\n') || '（等待输出）'}</pre>
        </>
      ) : null}

      {phase === 'done' ? (
        <>
          <p className="dm-lead">装好了。</p>
          <p className="dm-sub">如果还是连不上，重启一下 dsh web 就行。</p>
          <div className="dm-acts">
            <button className="dm-pri" onClick={onReady}>开始使用</button>
          </div>
        </>
      ) : null}

      {phase === 'error' ? (
        <>
          <p className="dm-lead">没装上。</p>
          <pre className="dm-log">{log.join('\n')}</pre>
          <div className="dm-acts">
            <button className="dm-pri" onClick={install}>再试一次</button>
            <button className="dm-sec" onClick={onReady}>重新检测</button>
          </div>
          <p className="dm-note">上面那段日志能说明卡在哪 —— 需要的话把它发给我</p>
        </>
      ) : null}
    </div>
  )
}
