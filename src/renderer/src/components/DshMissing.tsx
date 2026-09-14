import { useEffect, useState } from 'react'
import type { RuntimeStatusView } from '@shared/types'

/**
 * 「跑不起来」这条消息 —— 它不是状态条，是一条**对话**。
 *
 * 为什么放在聊天流里：缺 dsh 的本质是「我现在没法跟你说话」，那是助手说的一句话；
 * 按钮长在消息上，用户不用去别处找；聊天区本来就有这个位置。
 *
 * ⚠️ 它必须处理**两段**缺件，顺序不能反：
 *     Node.js → npm → dsh
 *   第一版只做了 dsh，结果在没有 Node 的机器上：点「帮我安装 dsh」→ 跑 npm → 
 *   「'npm' 不是内部或外部命令」→ 失败。用户看到的就是这个。
 *   所以先探环境：缺 Node 就先装 Node，装完再装 dsh。
 */

type Phase = 'idle' | 'node' | 'installing' | 'done' | 'error'

export function DshMissing({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [rt, setRt] = useState<RuntimeStatusView | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [probing, setProbing] = useState(true)

  const probe = (): void => {
    setProbing(true)
    void window.bubble.probeRuntime().then((r) => {
      setRt(r)
      // npm 不可用（没有 Node，或 Node 在探不到的地方）→ 必须先补 Node
      setPhase(r.npm.found ? 'idle' : 'node')
      setProbing(false)
    }).catch(() => setProbing(false))
  }

  useEffect(() => {
    probe()
    const offDshLine = window.bubble.onDshInstallLine((l) => setLog((p) => [...p.slice(-24), l]))
    const offDshDone = window.bubble.onDshInstallDone((r) => { setLog((p) => [...p, r.detail]); setPhase(r.ok ? 'done' : 'error') })
    const offNodeLine = window.bubble.onNodeInstallLine((l) => setLog((p) => [...p.slice(-24), l]))
    const offNodeDone = window.bubble.onNodeInstallDone((r) => {
      setLog((p) => [...p, r.detail])
      if (!r.ok) { setPhase('error'); return }
      // Node 装好了 → 重新探测，接着走 dsh 那一段
      void window.bubble.probeRuntime().then((x) => { setRt(x); setPhase(x.npm.found ? 'idle' : 'error') })
    })
    return () => { offDshLine(); offDshDone(); offNodeLine(); offNodeDone() }
  }, [])

  const installNode = (): void => { setLog([]); setPhase('installing'); void window.bubble.installNode() }
  const installDsh = (): void => { setLog([]); setPhase('installing'); void window.bubble.installDsh() }

  if (probing) return <div className="msg ai dshmiss-msg"><p className="dm-lead">正在看看这台机器缺什么…</p></div>

  return (
    <div className="msg ai dshmiss-msg">
      {phase === 'node' ? (
        <>
          <p className="dm-lead">我还没法回你话 —— 这台机器上没有 <b>Node.js</b>。</p>
          <p className="dm-sub">
            气泡的对话能力来自 <b>dsh</b>，而 dsh 要装在 Node.js 上。少了这一环，装 dsh 的那条命令根本跑不起来。
          </p>
          <div className="dm-acts">
            <button className="dm-pri" onClick={installNode}>帮我安装 Node.js（约 34 MB）</button>
            <button className="dm-sec" onClick={() => void window.bubble.openNodeDownload()}>我要自己装</button>
            <button className="dm-sec" onClick={probe}>我已经装好了，重新检测</button>
          </div>
          <p className="dm-note">装的是便携版：解压到气泡自己的数据目录，不需要管理员权限、不改系统 PATH</p>
        </>
      ) : null}

      {phase === 'idle' ? (
        <>
          <p className="dm-lead">我还没法回你话 —— 这台机器上没有 <b>dsh</b>（DeepSeek Harness）。</p>
          <p className="dm-sub">气泡本身只是个壳，真正干活的大脑是 dsh。装好它我才能接上话。</p>
          <div className="dm-acts">
            <button className="dm-pri" onClick={installDsh}>帮我安装 dsh</button>
            <button className="dm-sec" onClick={onReady}>我自己装好了，重新检测</button>
          </div>
          <p className="dm-note">约 200 MB，走你本机的 npm{rt?.npm.version ? ' v' + rt.npm.version : ''}，可能要几分钟</p>
        </>
      ) : null}

      {phase === 'installing' ? (
        <>
          <p className="dm-lead">正在装…</p>
          <pre className="dm-log">{log.join('\n') || '（等待输出）'}</pre>
        </>
      ) : null}

      {phase === 'done' ? (
        <>
          <p className="dm-lead">装好了。</p>
          <p className="dm-sub">如果还是连不上，重启一下 dsh web 就行。</p>
          <div className="dm-acts"><button className="dm-pri" onClick={onReady}>开始使用</button></div>
        </>
      ) : null}

      {phase === 'error' ? (
        <>
          <p className="dm-lead">没装上。</p>
          <pre className="dm-log">{log.join('\n')}</pre>
          <div className="dm-acts">
            <button className="dm-pri" onClick={probe}>重新检测</button>
          </div>
          <p className="dm-note">上面那段日志能说明卡在哪 —— 需要的话把它发给我</p>
        </>
      ) : null}
    </div>
  )
}
