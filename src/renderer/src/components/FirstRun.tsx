import { useEffect, useState } from 'react'
import type { RuntimeStatusView } from '@shared/types'

type Step = 'checking' | 'need-node' | 'missing' | 'installing' | 'installed' | 'apikey' | 'integrate' | 'done'

/**
 * 首次运行向导。
 *
 * 安装包**不内置** dsh 与 Node.js（方案 D3：它们独立演进，内置会僵）。
 * 所以这里按「先校验、再安装」的顺序走：
 *
 *   ① 机器上已有 → **只用不装**（尊重用户环境，绝不重复安装）
 *   ② 机器上没有 → 问过用户之后，气泡帮他装
 *
 * 链子是 Node.js → npm → dsh。以前卡在第一环（只能引导用户自己去 nodejs.org 下载），
 * 结果整条链走不通，用户看到的就是「它只检测，什么都不帮我装」。
 */
export function FirstRun({ onFinish }: { onFinish: (skip: boolean) => void }) {
  const [step, setStep] = useState<Step>('checking')
  const [rt, setRt] = useState<RuntimeStatusView | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [integrated, setIntegrated] = useState(false)
  const [key, setKey] = useState('')
  const [keyState, setKeyState] = useState<{ configured: boolean } | null>(null)
  const [keyMsg, setKeyMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const check = (): void => {
    setStep('checking')
    void window.bubble.probeRuntime().then((r) => {
      setRt(r)
      if (r.dsh.found) {
        setStep('installed')
        void window.bubble.apiKeyState().then(setKeyState)
      } else if (!r.node.found) {
        setStep('need-node')
      } else {
        setStep('missing')
      }
    })
  }

  useEffect(() => {
    check()
    const offDshLine = window.bubble.onDshInstallLine((l) => setLog((p) => [...p.slice(-30), l]))
    const offDshDone = window.bubble.onDshInstallDone((r) => {
      setLog((p) => [...p, r.detail])
      setBusy(false)
      setTimeout(check, 800)
    })
    const offNodeLine = window.bubble.onNodeInstallLine((l) => setLog((p) => [...p.slice(-30), l]))
    const offNodeDone = window.bubble.onNodeInstallDone((r) => {
      setLog((p) => [...p, r.detail])
      setBusy(false)
      setTimeout(check, 800)
    })
    return () => { offDshLine(); offDshDone(); offNodeLine(); offNodeDone() }
  }, [])

  const saveKey = async (): Promise<void> => {
    const r = await window.bubble.setApiKey(key.trim())
    if (r.ok) {
      setKeyMsg('已保存')
      setKey('')
      setKeyState({ configured: true })
      setTimeout(() => setStep('installed'), 900)
    } else {
      setKeyMsg(r.error ?? '保存失败')
    }
  }

  /** 帮装 Node.js（便携版，34MB，不需要管理员） */
  const installNode = (): void => {
    setLog(['开始下载便携版 Node.js（约 34 MB，走国内镜像）…'])
    setBusy(true)
    setStep('installing')
    void window.bubble.installNode()
  }

  /** 帮装 dsh（有系统 npm 就用系统的，没有才用便携版） */
  const installDsh = (): void => {
    setLog(['开始安装 @deepseek-ai/dsh …（可能要几分钟）'])
    setBusy(true)
    setStep('installing')
    void window.bubble.installDsh()
  }

  return (
    <div className="firstrun">
      <div className="fr-card">
        <div className="fr-logo">🫧</div>
        <h1>桌面气泡助手</h1>

        {step === 'checking' ? <p className="fr-p">正在检查运行环境…</p> : null}

        {/* ── 连 Node.js 都没有：这是链条的第一环，必须先补 ── */}
        {step === 'need-node' ? (
          <>
            <p className="fr-p">
              这台机器没有 <b>Node.js</b>。<br />
              气泡的对话能力依赖 <b>dsh</b>，而 dsh 需要它 —— 我可以直接帮你装。
            </p>
            <div className="fr-acts">
              <button className="pri" onClick={installNode}>帮我安装 Node.js（约 34 MB）</button>
              <button onClick={() => void window.bubble.openNodeDownload()}>我要自己装</button>
              <button onClick={check}>我已经装好了，重新检测</button>
            </div>
            <div className="fr-note">
              装的是**便携版**：解压到气泡自己的数据目录，不需要管理员权限、不改系统 PATH、
              卸载时删掉即可。它只给气泡用，和你自己装的 Node 互不干扰。
            </div>
          </>
        ) : null}

        {/* ── 有 Node.js，缺 dsh ── */}
        {step === 'missing' ? (
          <>
            <p className="fr-p">
              运行环境已就绪{rt?.node.version ? '（Node ' + rt.node.version + '）' : ''}，
              但还没有 <b>dsh</b>（DeepSeek Harness）。<br />
              气泡只是一个壳 —— 真正干活的大脑是 dsh。
            </p>
            <div className="fr-acts">
              <button className="pri" onClick={installDsh}>帮我安装 dsh</button>
              <button onClick={check}>我已经有了，重新检测</button>
            </div>
            <div className="fr-note">
              走你本机的 npm{rt?.npm.version ? ' v' + rt.npm.version : ''}（需要联网，约 200 MB，可能要几分钟）
            </div>
          </>
        ) : null}

        {step === 'installing' ? (
          <>
            <p className="fr-p">{busy ? '正在安装，请不要关闭窗口…' : '完成'}</p>
            <pre className="fr-log">{log.join('\n') || '（等待输出）'}</pre>
          </>
        ) : null}

        {step === 'installed' ? (
          <>
            <p className="fr-p">
              已检测到 dsh {rt?.dsh.version ? <b>v{rt.dsh.version}</b> : null}。
              {rt?.dsh.source === 'portable' ? <><br /><span style={{ color: '#6e7686', fontSize: 11 }}>（用的是气泡帮你装的版本）</span></> : null}
              <br />还差最后一步：把气泡的 MCP 工具与状态块接入 dsh。
            </p>
            {keyState && !keyState.configured ? (
              <p className="fr-p" style={{ color: '#ffb86b' }}>
                另外还缺一个 <b>DeepSeek API Key</b> —— 没有它 dsh 连不上模型，发消息会失败。
              </p>
            ) : null}
            <div className="fr-acts">
              {keyState && !keyState.configured ? (
                <button className="pri" onClick={() => setStep('apikey')}>填写 API Key</button>
              ) : null}
              <button className={keyState && !keyState.configured ? '' : 'pri'} onClick={() => {
                setStep('integrate')
                void window.bubble.integrate().then((r) => {
                  setLog((p) => [...p, r.detail])
                  setIntegrated(r.ok)
                  setTimeout(() => setStep('done'), 900)
                })
              }}>一键接入</button>
              <button onClick={() => onFinish(false)}>先跳过，直接开始</button>
            </div>
          </>
        ) : null}

        {step === 'apikey' ? (
          <>
            <p className="fr-p">
              把 DeepSeek 的 API Key 填进来，我会写进 dsh 的凭据文件。<br />
              <span style={{ color: '#6e7686', fontSize: 11 }}>只在这一个方向写，绝不回读。</span>
            </p>
            <input
              className="fr-input"
              type="password"
              autoFocus
              placeholder="sk-…"
              value={key}
              onChange={(e) => { setKey(e.target.value); setKeyMsg('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveKey() }}
            />
            {keyMsg ? <div className="fr-note" style={{ color: keyMsg.includes('已保存') ? '#7ee0a0' : '#ffb3b3' }}>{keyMsg}</div> : null}
            <div className="fr-acts" style={{ marginTop: 10 }}>
              <button className="pri" disabled={key.trim().length < 8} onClick={() => void saveKey()}>保存</button>
              <button onClick={() => setStep('installed')}>先跳过</button>
            </div>
            <div className="fr-note">不知道去哪拿？在 platform.deepseek.com 的「API Keys」里创建</div>
          </>
        ) : null}

        {step === 'integrate' ? <p className="fr-p">正在接入…</p> : null}

        {step === 'done' ? (
          <>
            <p className="fr-p">
              {integrated ? '接入完成。' : '已跳过接入。'}<br />
              {integrated ? '重启 dsh web 后，模型就能调用 bubble_* 工具了。' : '你随时可以在「设置 → 高级」里接入。'}
            </p>
            <div className="fr-acts">
              <button className="pri" onClick={() => { void window.bubble.reconnect().finally(() => onFinish(false)) }}>开始使用</button>
            </div>
          </>
        ) : null}

        {step !== 'installing' && step !== 'integrate' ? (
          <button className="fr-skip" onClick={() => onFinish(true)}>稍后再说</button>
        ) : null}
      </div>
    </div>
  )
}
