import { useEffect, useState } from 'react'
import type { RuntimeStatusView } from '@shared/types'

/**
 * 气泡里的「引导」—— 它是一条**助手消息**，不是状态条。
 *
 * 缺什么就在这里说什么、按钮就长在消息上，用户全程不离开聊天窗口：
 *
 *   ① Node.js 没有      → [帮我安装 Node.js]
 *   ② dsh 没有          → [帮我安装 dsh]
 *   ③ dsh 有但没跑起来   → [启动 dsh]      ← 不用重启气泡
 *   ④ 跑起来了但没 Key   → 就地输入框 + 截图指引
 *
 * 全都没问题时它渲染 null（所以可以无条件放在消息流里）。
 *
 * 注意顺序不能反：链子是 Node.js → npm → dsh，第一环断了后面全断。
 */

type Phase = 'probing' | 'node' | 'dsh' | 'notRunning' | 'noKey' | 'installing' | 'done' | 'error' | 'ok'

export function DshMissing({
  connected,
  detail,
  onReady,
}: {
  connected: boolean
  /** supervisor 给的诊断 ——「dsh 有但没跑起来」时最有用的就是它 */
  detail?: string
  onReady: () => void
}) {
  const [phase, setPhase] = useState<Phase>('probing')
  const [rt, setRt] = useState<RuntimeStatusView | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [key, setKey] = useState('')
  const [keyMsg, setKeyMsg] = useState('')
  const [guideImg, setGuideImg] = useState('')
  const [startDetail, setStartDetail] = useState('')

  const probe = (): void => {
    setPhase('probing')
    void Promise.all([window.bubble.probeRuntime(), window.bubble.apiKeyState()])
      .then(([r, k]) => {
        setRt(r)
        if (!r.node.found) setPhase('node')
        else if (!r.dsh.found) setPhase('dsh')
        else if (!connected) setPhase('notRunning')
        else if (!k.configured) setPhase('noKey')
        else setPhase('ok')
      })
      .catch(() => setPhase('error'))
  }

  useEffect(() => { probe() }, [connected])

  useEffect(() => {
    const offDshLine = window.bubble.onDshInstallLine((l) => setLog((p) => [...p.slice(-24), l]))
    const offDshDone = window.bubble.onDshInstallDone((r) => { setLog((p) => [...p, r.detail]); setPhase(r.ok ? 'done' : 'error') })
    const offNodeLine = window.bubble.onNodeInstallLine((l) => setLog((p) => [...p.slice(-24), l]))
    const offNodeDone = window.bubble.onNodeInstallDone((r) => {
      setLog((p) => [...p, r.detail])
      if (!r.ok) { setPhase('error'); return }
      void window.bubble.probeRuntime().then((x) => { setRt(x); setPhase(x.npm.found ? 'dsh' : 'error') })
    })
    return () => { offDshLine(); offDshDone(); offNodeLine(); offNodeDone() }
  }, [])

  // 只在真的要引导时才去取那张图（72KB，别白拉）
  useEffect(() => {
    if (phase !== 'noKey' || guideImg) return
    void window.bubble.apiKeyGuideImage().then(setGuideImg)
  }, [phase, guideImg])

  const installNode = (): void => { setLog([]); setPhase('installing'); void window.bubble.installNode() }
  const installDsh = (): void => { setLog([]); setPhase('installing'); void window.bubble.installDsh() }
  const startDsh = (): void => {
    setStartDetail('正在启动 dsh web …')
    void window.bubble.startDsh().then((r) => {
      setStartDetail(r.detail || (r.ok ? '已启动' : '启动失败'))
      if (r.ok) { onReady(); setTimeout(probe, 800) }
    })
  }
  const saveKey = async (): Promise<void> => {
    const r = await window.bubble.setApiKey(key.trim())
    if (r.ok) { setKeyMsg('已保存'); setKey(''); setTimeout(() => { onReady(); probe() }, 900) }
    else setKeyMsg(r.error ?? '保存失败')
  }

  if (phase === 'probing' || phase === 'ok') return null

  return (
    <div className="msg ai dshmiss-msg">
      {phase === 'node' ? (<>
        <p className="dm-lead">我还没法回你话 —— 这台机器上没有 <b>Node.js</b>。</p>
        <p className="dm-sub">气泡的对话能力来自 dsh，而 dsh 要装在 Node.js 上。少了这一环，装 dsh 的命令根本跑不起来。</p>
        <div className="dm-acts">
          <button className="dm-pri" onClick={installNode}>帮我安装 Node.js（约 34 MB）</button>
          <button className="dm-sec" onClick={() => void window.bubble.openNodeDownload()}>我要自己装</button>
          <button className="dm-sec" onClick={probe}>重新检测</button>
        </div>
        <p className="dm-note">装的是便携版：解压到气泡自己的数据目录，不需要管理员权限、不改系统 PATH</p>
      </>) : null}

      {phase === 'dsh' ? (<>
        <p className="dm-lead">我还没法回你话 —— 这台机器上没有 <b>dsh</b>。</p>
        <p className="dm-sub">气泡本身只是个壳，真正干活的大脑是 dsh。装好它我才能接上话。</p>
        <div className="dm-acts">
          <button className="dm-pri" onClick={installDsh}>帮我安装 dsh</button>
          <button className="dm-sec" onClick={probe}>重新检测</button>
        </div>
        <p className="dm-note">约 200 MB，走你本机的 npm{rt?.npm.version ? ' v' + rt.npm.version : ''}，可能要几分钟</p>
      </>) : null}

      {phase === 'notRunning' ? (<>
        <p className="dm-lead">dsh 装好了，但<b>没跑起来</b>。</p>
        <p className="dm-sub">它需要作为后台服务运行，气泡才能连上。点下面试试 —— 不用重启气泡。</p>
        <div className="dm-acts">
          <button className="dm-pri" onClick={startDsh}>启动 dsh</button>
          <button className="dm-sec" onClick={probe}>重新检测</button>
        </div>
        {startDetail ? <pre className="dm-log">{startDetail}</pre> : null}
        {/* supervisor 的诊断最有价值 —— 里面有 dsh web 自己说的话 */}
        {!startDetail && detail ? <pre className="dm-log">{detail}</pre> : null}
      </>) : null}

      {phase === 'noKey' ? (<>
        <p className="dm-lead">dsh 跑起来了，但<b>还差一个 API Key</b>。</p>
        <p className="dm-sub">没有它我连不上模型 —— 发消息会失败。填一次就够。</p>
        <div className="dm-keyrow">
          <input
            className="dm-input"
            type="password"
            placeholder="sk-…"
            value={key}
            onChange={(e) => { setKey(e.target.value); setKeyMsg('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveKey() }}
          />
          <button className="dm-pri" disabled={key.trim().length < 8} onClick={() => void saveKey()}>保存</button>
        </div>
        {keyMsg ? <p className="dm-note" style={{ color: keyMsg.includes('已保存') ? '#7ee0a0' : '#ffb3b3' }}>{keyMsg}</p> : null}
        <details className="dm-more">
          <summary>不知道去哪拿？看这张图</summary>
          <p className="dm-note">在 dsh web 界面里：设置 → 模型 → 添加提供方 → 填 DeepSeek 的 API Key</p>
          {guideImg ? <img className="dm-guide" src={guideImg} alt="API Key 设置指引" /> : null}
        </details>
      </>) : null}

      {phase === 'installing' ? (<>
        <p className="dm-lead">正在装…</p>
        <pre className="dm-log">{log.join('\n') || '（等待输出）'}</pre>
      </>) : null}

      {phase === 'done' ? (<>
        <p className="dm-lead">装好了。</p>
        <div className="dm-acts">
          <button className="dm-pri" onClick={() => { onReady(); probe() }}>接着往下走</button>
        </div>
      </>) : null}

      {phase === 'error' ? (<>
        <p className="dm-lead">没成功。</p>
        <pre className="dm-log">{log.join('\n') || '（没有输出）'}</pre>
        <div className="dm-acts"><button className="dm-pri" onClick={probe}>重新检测</button></div>
        <p className="dm-note">上面那段能说明卡在哪 —— 需要的话把它发给我</p>
      </>) : null}
    </div>
  )
}
