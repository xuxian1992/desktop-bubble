import { useEffect, useState } from 'react'
import type {
  BubbleConfig, DiaryEntryView, DshProbeView, HotkeyAction, IntegrationState, MonitorMode, PerceptionView,
  RuntimeStatusView,
} from '@shared/types'
import { HOTKEY_LABELS, MONITOR_LABELS } from '@shared/types'

type Cat = 'general' | 'appearance' | 'hotkeys' | 'session' | 'perception' | 'attach' | 'privacy' | 'advanced'

const CATS: Array<{ id: Cat; icon: string; name: string }> = [
  { id: 'general', icon: '🖥', name: '通用' },
  { id: 'appearance', icon: '🎨', name: '外观' },
  { id: 'hotkeys', icon: '⌨', name: '快捷键' },
  { id: 'session', icon: '💬', name: '会话' },
  { id: 'perception', icon: '👁', name: '屏幕感知' },
  { id: 'attach', icon: '📎', name: '附件与图片' },
  { id: 'privacy', icon: '🔒', name: '隐私与数据' },
  { id: 'advanced', icon: '🔧', name: '高级' },
]

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="row2">
      <span className="lbl">{label}{hint ? <small>{hint}</small> : null}</span>
      {children}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <span className={'sw' + (on ? ' on' : '')} onClick={() => onChange(!on)}><i /></span>
}

function HotkeyEditor({ action, value, onSaved }: { action: HotkeyAction; value: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const commit = async (accel: string): Promise<void> => {
    const r = await window.bubble.setHotkey(action, accel)
    if (r.ok) { setEditing(false); setErr(null); onSaved() }
    else setErr(r.error ?? '设置失败')
  }

  if (!editing) {
    return <span className="kbd2" onClick={() => { setEditing(true); setErr(null) }} title="点击修改">{value}</span>
  }
  return (
    <span className="kbd2 ed" tabIndex={0} autoFocus
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        e.preventDefault()
        if (e.key === 'Escape') { setEditing(false); return }
        const mods: string[] = []
        if (e.ctrlKey) mods.push('Control')
        if (e.altKey) mods.push('Alt')
        if (e.shiftKey) mods.push('Shift')
        const k = e.key
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return
        const key = k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k
        void commit([...mods, key].join('+'))
      }}>
      {err ?? '按下新组合…'}
    </span>
  )
}

function DiaryList({ entries }: { entries: DiaryEntryView[] }) {
  if (entries.length === 0) return <div className="diary"><div className="none">还没有记录 —— 把档位调到「仅感知」就会开始</div></div>
  return (
    <div className="diary">
      {entries.slice(0, 40).map((e, i) => (
        <div key={i} className={'e' + (e.kind === 'tag' ? ' tag' : '')}>
          <span className="tm">{new Date(e.t).toLocaleTimeString()}</span>
          <span className="kd">{e.kind === 'change' ? '画面' : e.kind === 'window' ? '窗口' : e.kind === 'tag' ? '事件' : '状态'}</span>
          <span className="tx" title={e.text}>{e.text}</span>
        </div>
      ))}
    </div>
  )
}

export function SettingsView({ config, onPatch, onBack, dshUrl }: {
  config: BubbleConfig | null
  onPatch: (p: Partial<BubbleConfig>) => void
  onBack: () => void
  dshUrl: string
}) {
  const [cat, setCat] = useState<Cat>('general')
  const [hotkeys, setHotkeys] = useState<Record<HotkeyAction, string> | null>(null)
  const [failed, setFailed] = useState<HotkeyAction[]>([])
  const [perc, setPerc] = useState<PerceptionView | null>(null)
  const [excludeDraft, setExcludeDraft] = useState('')
  const [version, setVersion] = useState('')
  const [probe, setProbe] = useState<DshProbeView | null>(null)
  const [rt, setRt] = useState<RuntimeStatusView | null>(null)
  const [integState, setIntegState] = useState<IntegrationState | null>(null)
  const [integMsg, setIntegMsg] = useState('')
  const [installLog, setInstallLog] = useState<string[]>([])
  const [keyState, setKeyState] = useState<{ configured: boolean } | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyEditing, setKeyEditing] = useState(false)
  const [keyMsg, setKeyMsg] = useState('')

  useEffect(() => {
    void window.bubble.probeDsh().then(setProbe)
    void window.bubble.probeRuntime().then(setRt)
    void window.bubble.integrationState().then(setIntegState)
    void window.bubble.apiKeyState().then(setKeyState)
    const offLine = window.bubble.onDshInstallLine((l) => setInstallLog((prev) => [...prev.slice(-40), l]))
    const offDone = window.bubble.onDshInstallDone((r) => {
      setInstallLog((prev) => [...prev, r.detail])
      void window.bubble.probeDsh().then(setProbe)
      void window.bubble.probeRuntime().then(setRt)
    })
    const offNode = window.bubble.onNodeInstallLine((l) => setInstallLog((prev) => [...prev.slice(-40), l]))
    const offNodeDone = window.bubble.onNodeInstallDone((r) => {
      setInstallLog((prev) => [...prev, r.detail])
      void window.bubble.probeRuntime().then(setRt)
      void window.bubble.probeDsh().then(setProbe)
    })
    return () => { offLine(); offDone(); offNode(); offNodeDone() }
  }, [])

  /** 删掉我们帮装的便携版 Node.js（用户自己装的那份不动） */
  const doRemoveNode = (): void => {
    void window.bubble.removeNode().then((r) => {
      setInstallLog((prev) => [...prev, r.detail])
      void window.bubble.probeRuntime().then(setRt)
    })
  }

  const doInstallDsh = (): void => {
    setInstallLog(['开始安装 @deepseek-ai/dsh …'])
    void window.bubble.installDsh()
  }

  useEffect(() => {
    void window.bubble.getPerception().then(setPerc)
    void window.bubble.appVersion().then(setVersion)
    return window.bubble.onPerceptionChanged(setPerc)
  }, [])

  const reload = (): void => {
    void window.bubble.getHotkeys().then(setHotkeys)
    void window.bubble.failedHotkeys().then(setFailed)
  }
  useEffect(() => { reload() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onBack() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const c = config
  const integ = integState?.integrated ?? false

  return (
    <div className="chatwrap">
      <div className="sethdr">
        <button className="back" onClick={onBack}>← 返回气泡</button>
        <span className="t">设置</span>
        <span className="esc">Esc 返回 · 窗口会切回原形态</span>
      </div>
      <div className="setwrap">
        <div className="setnav">
          {CATS.map((x) => (
            <div key={x.id} className={'it' + (cat === x.id ? ' a' : '')} onClick={() => setCat(x.id)}>
              {x.icon} {x.name}
            </div>
          ))}
        </div>
        <div className="setbody">
          {cat === 'general' ? (
            <>
              <h4>通用</h4>
              <div className="desc">气泡的启动、常驻与窗口行为</div>
              <div className="sect">
                <div className="ttl">启动</div>
                <Row label="开机自动启动" hint="登录 Windows 后自动运行，常驻托盘">
                  <Toggle on={!!c?.autoStart} onChange={(v) => onPatch({ autoStart: v })} />
                </Row>
                <Row label="启动时自动拉起 dsh web" hint="探活 3080，已在跑就复用">
                  <Toggle on={c?.autoLaunchDsh !== false} onChange={(v) => onPatch({ autoLaunchDsh: v })} />
                </Row>
                <Row
                  label="关闭按钮行为"
                  hint={c?.closeToTray !== false
                    ? '点 ✕ 收进托盘 —— 程序继续后台运行，热键仍可用'
                    : '点 ✕ 直接退出 —— 进程结束，热键与常驻全部停止'}
                >
                  {/* ⚠️ 以前这里是个没有 onClick 的 span：设置显示了却点不动，等于假的 */}
                  <span
                    className="sel2"
                    style={{ cursor: 'pointer' }}
                    onClick={() => onPatch({ closeToTray: c?.closeToTray === false })}
                  >
                    {c?.closeToTray !== false ? '收进托盘' : '直接退出'}<span className="ar">▼</span>
                  </span>
                </Row>
              </div>
              <div className="sect">
                <div className="ttl">窗口</div>
                <Row label="侧边栏默认展开">
                  <Toggle on={!!c?.sidebarOpen} onChange={(v) => void window.bubble.setSidebarOpen(v)} />
                </Row>
              </div>
            </>
          ) : null}

          {cat === 'appearance' ? (
            <>
              <h4>外观</h4>
              <div className="desc">消息渲染</div>
              <div className="sect">
                <Row label="Markdown 渲染" hint="关闭后消息按纯文本显示">
                  <Toggle on={c?.markdown !== false} onChange={(v) => onPatch({ markdown: v })} />
                </Row>
              </div>
            </>
          ) : null}

          {cat === 'hotkeys' ? (
            <>
              <h4>快捷键</h4>
              <div className="desc">点击任意快捷键即可按新组合录入；被占用时会提示并保留原值</div>
              <div className="sect">
                {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((a) => (
                  <Row key={a} label={HOTKEY_LABELS[a]}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {failed.includes(a) ? <span style={{ fontSize: 10, color: '#ff9b9b' }}>注册失败</span> : null}
                      <HotkeyEditor action={a} value={hotkeys?.[a] ?? '—'} onSaved={reload} />
                    </span>
                  </Row>
                ))}
              </div>
            </>
          ) : null}

          {cat === 'attach' ? (
            <>
              <h4>附件与图片</h4>
              <div className="desc">控制发出去的附件有多大</div>
              <div className="sect">
                <Row label="图片长边上限" hint={'当前 ' + (c?.imageMaxEdge ?? 1280) + 'px'}>
                  <span className="sel2" onClick={() => onPatch({ imageMaxEdge: ((c?.imageMaxEdge ?? 1280) === 1280 ? 960 : (c?.imageMaxEdge ?? 1280) === 960 ? 720 : 1280) })}>
                    {c?.imageMaxEdge ?? 1280} px<span className="ar">▼</span>
                  </span>
                </Row>
                <Row label="小文件内联阈值" hint="超过这个大小只发路径">
                  <span className="sel2" onClick={() => onPatch({ inlineLimitBytes: ((c?.inlineLimitBytes ?? 204800) === 204800 ? 51200 : (c?.inlineLimitBytes ?? 204800) === 51200 ? 524288 : 204800) })}>
                    {Math.round((c?.inlineLimitBytes ?? 204800) / 1024)} KB<span className="ar">▼</span>
                  </span>
                </Row>
              </div>
            </>
          ) : null}

          {cat === 'perception' ? (
            <>
              <h4>屏幕感知</h4>
              <div className="desc">感知留在本地，token 只在值得时才花</div>
              <div className="sect">
                <div className="ttl">档位</div>
                {(['off', 'passive'] as MonitorMode[]).map((m) => (
                  <Row key={m} label={MONITOR_LABELS[m].name} hint={MONITOR_LABELS[m].desc}>
                    <Toggle on={(perc?.mode ?? 'off') === m} onChange={() => {
                      void window.bubble.setMonitorMode((perc?.mode ?? 'off') === m ? 'off' : m).then(setPerc)
                    }} />
                  </Row>
                ))}
              </div>
              <div className="sect">
                <div className="ttl">启动时的默认档位</div>
                <Row
                  label={MONITOR_LABELS[config?.defaultMonitor ?? 'off'].name}
                  hint={'每次启动自动切到这一档 · ' + MONITOR_LABELS[config?.defaultMonitor ?? 'off'].desc}
                >
                  <span className="sel2" onClick={() => {
                    const opts: MonitorMode[] = ['off', 'passive']
                    const cur = config?.defaultMonitor ?? 'off'
                    onPatch({ defaultMonitor: opts[(opts.indexOf(cur) + 1) % opts.length] })
                  }}>{MONITOR_LABELS[config?.defaultMonitor ?? 'off'].name}<span className="ar">▼</span></span>
                </Row>
                <div className="desc" style={{ paddingTop: 4 }}>
                  这里定的是**每次启动的默认值**；当前这一会儿的状态仍在气泡顶部的 🖥 里临时改，两者互不覆盖。
                </div>
              </div>
              <div className="sect">
                <div className="ttl">本地采样</div>
                <Row label="采样间隔" hint="越小越灵敏，但本地 CPU 占用更高（不产生 token）">
                  <span className="sel2" onClick={() => {
                    const cur = config?.perceptSampleMs ?? 3000
                    const opts = [1000, 3000, 5000, 10000]
                    onPatch({ perceptSampleMs: opts[(opts.indexOf(cur) + 1) % opts.length] })
                  }}>{Math.round((config?.perceptSampleMs ?? 3000) / 1000)} 秒<span className="ar">▼</span></span>
                </Row>
                <Row label="日记保留" hint="超过时长的片段自动丢弃">
                  <span className="sel2" onClick={() => {
                    const cur = config?.perceptDiaryMinutes ?? 15
                    const opts = [5, 15, 30, 60]
                    onPatch({ perceptDiaryMinutes: opts[(opts.indexOf(cur) + 1) % opts.length] })
                  }}>{config?.perceptDiaryMinutes ?? 15} 分钟<span className="ar">▼</span></span>
                </Row>
              </div>
              <div className="sect">
                <div className="ttl">本次已感知（本地，未上传）</div>
                <div className="perception-sum" style={{ borderTop: 0, padding: '0 0 8px' }}>
                  采样 {perc?.samples ?? 0} 次 · 变化 {perc?.changes ?? 0} 次 · 日记 {perc?.diary.length ?? 0} 条<br />
                  已上传 {perc?.uploadedFrames ?? 0} 帧 · 估算 {perc?.estTokens ?? 0} token
                </div>
                <DiaryList entries={perc?.diary ?? []} />
              </div>
            </>
          ) : null}

          {cat === 'privacy' ? (
            <>
              <h4>隐私与数据</h4>
              <div className="desc">屏幕日记只存在本机内存里</div>
              <div className="sect">
                <div className="ttl">排除的应用</div>
                <div className="row2">
                  <input className="srename" style={{ maxWidth: 220 }} value={excludeDraft}
                    placeholder="窗口标题包含这个词就不记录，如 1Password"
                    onChange={(e) => setExcludeDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      const v = excludeDraft.trim()
                      if (!v) return
                      onPatch({ excludeApps: [...(config?.excludeApps ?? []), v] })
                      setExcludeDraft('')
                    }} />
                  <span style={{ fontSize: 10.5, color: '#6e7686' }}>回车添加</span>
                </div>
                {(config?.excludeApps ?? []).map((k) => (
                  <div className="row2" key={k}>
                    <span className="lbl">{k}</span>
                    <span className="kbd2" onClick={() => onPatch({ excludeApps: (config?.excludeApps ?? []).filter((x) => x !== k) })}>移除</span>
                  </div>
                ))}
                {(config?.excludeApps ?? []).length === 0 ? (
                  <div style={{ fontSize: 10.5, color: '#6e7686', padding: '4px 0' }}>（未设置排除项）</div>
                ) : null}
              </div>
              <div className="sect">
                <div className="ttl">数据</div>
                <Row label="清空本地屏幕日记" hint="立即丢弃已记录的全部片段">
                  <span className="kbd2" onClick={() => void window.bubble.clearDiary().then(setPerc)}>清空</span>
                </Row>
                <Row label="打开数据目录">
                  <span className="kbd2" onClick={() => void window.bubble.openDataDir()}>打开</span>
                </Row>
              </div>
              <div className="sect">
                <div className="ttl">承诺</div>
                <div style={{ fontSize: 11.5, color: '#7b8494', lineHeight: 1.8 }}>
                  · 感知在本地完成，截图与哈希**不会**自动离开这台机器<br />
                  · 只有你（或模型在你要求下）主动取回时才发送，且每次都记在状态条里<br />
                  · 屏幕日记默认只存内存，关掉气泡即消失
                </div>
              </div>
            </>
          ) : null}

          {cat === 'session' ? (
            <>
              <h4>会话</h4>
              <div className="desc">新建会话与列表的默认行为</div>
              <div className="sect">
                <Row label="侧边栏默认展开">
                  <Toggle on={!!config?.sidebarOpen} onChange={(v) => void window.bubble.setSidebarOpen(v)} />
                </Row>
                <Row label="子代理会话" hint="同一次并行的子代理标题相同，默认折叠避免刷屏">
                  <span className="sel2">已折叠<span className="ar">▼</span></span>
                </Row>
                <Row label="归档会话" hint="归档后不出现在列表中，但记录保留">
                  <span className="sel2">已隐藏<span className="ar">▼</span></span>
                </Row>
              </div>
              <div className="sect">
                <div className="ttl">说明</div>
                <div style={{ fontSize: 11.5, color: '#7b8494', lineHeight: 1.8 }}>
                  首屏加载 {14} 条消息；向上滚动会继续向前翻页。<br />
                  新会话的工作目录取「最近工作区」，可在侧边栏底部添加。
                </div>
              </div>
            </>
          ) : null}

          {cat === 'advanced' ? (
            <>
              <h4>高级</h4>
              <div className="desc">连接与诊断</div>
              <div className="sect">
                <Row label="dsh 服务地址" hint="启动时探活，已在跑就复用">
                  <span className="kbd2">{dshUrl || '—'}</span>
                </Row>
                <Row label="气泡版本">
                  <span className="kbd2">v{version || '—'}</span>
                </Row>
                <Row label="配置目录">
                  <span className="kbd2" onClick={() => void window.bubble.openDataDir()}>打开</span>
                </Row>
              </div>

              <div className="sect">
                <div className="ttl">模型密钥</div>
                <Row
                  label={keyState ? (keyState.configured ? '已配置 DeepSeek API Key' : '还没有配置 API Key') : '检查中…'}
                  hint="写进 dsh 的凭据文件（DEEPSEEK_API_KEY）；没有它无法聊天">
                  <span className="kbd2" onClick={() => { setKeyEditing(!keyEditing); setKeyMsg('') }}>{keyEditing ? '取消' : '填写'}</span>
                </Row>
                {keyEditing ? (
                  <div className="row2">
                    <input
                      className="srename"
                      style={{ maxWidth: 280 }}
                      type="password"
                      placeholder="sk-…"
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || keyDraft.trim().length < 8) return
                        void window.bubble.setApiKey(keyDraft.trim()).then((r) => {
                          setKeyMsg(r.ok ? '已保存' : (r.error ?? '保存失败'))
                          if (r.ok) { setKeyDraft(''); setKeyEditing(false); setKeyState({ configured: true }) }
                        })
                      }}
                    />
                    <span style={{ fontSize: 10.5, color: '#6e7686' }}>回车保存</span>
                  </div>
                ) : null}
                {keyMsg ? <div style={{ fontSize: 10.5, color: '#7b8494', paddingTop: 4 }}>{keyMsg}</div> : null}
              </div>

              <div className="sect">
                <div className="ttl">运行环境</div>
                <div className="desc" style={{ paddingBottom: 6 }}>
                  链子是 Node.js → npm → dsh。**机器上已有的只用不装**，没有的才帮你装。
                </div>
                <Row
                  label={rt ? (rt.node.found ? 'Node.js ' + (rt.node.version ?? '') : '没有 Node.js') : '检测中…'}
                  hint={rt?.node.found
                    ? (rt.node.portable ? '气泡帮装的便携版（不影响系统）' : '用你本机已装的')
                    : '没有它就装不了 dsh'}>
                  {rt?.node.portable ? (
                    <span className="kbd2" onClick={doRemoveNode}>删除便携版</span>
                  ) : (
                    <span className="kbd2" onClick={() => void window.bubble.probeRuntime().then(setRt)}>刷新</span>
                  )}
                </Row>
                <Row
                  label={rt ? (rt.npm.found ? 'npm ' + (rt.npm.version ?? '') : '没有 npm') : '检测中…'}
                  hint={rt?.npm.found ? (rt.npm.portable ? '来自便携版 Node.js' : '用你本机已装的') : '没有它装不了 dsh'}>
                  <span className="kbd2" onClick={() => void window.bubble.probeRuntime().then(setRt)}>刷新</span>
                </Row>
                <Row
                  label={rt ? (rt.dsh.found ? 'dsh ' + (rt.dsh.version ?? '') : '没有 dsh') : '检测中…'}
                  hint={rt?.dsh.found
                    ? ('来源：' + (rt.dsh.source === 'portable' ? '气泡帮装的' : rt.dsh.source === 'global-npm' ? '你 npm 全局装的' : '系统 PATH'))
                    : '气泡只是一个壳，真正干活的大脑是 dsh'}>
                  {rt?.dsh.found ? (
                    <span className="kbd2" onClick={() => void window.bubble.probeRuntime().then(setRt)}>重新检测</span>
                  ) : (
                    <span className="kbd2" onClick={doInstallDsh}>帮我安装</span>
                  )}
                </Row>
                {installLog.length > 0 ? <pre className="installlog">{installLog.join('\n')}</pre> : null}
              </div>

              <div className="sect">
                <div className="ttl">接入 dsh（MCP 工具 + 状态块 + 灵魂）</div>
                <Row
                  label={integ ? '已接入' : '未接入'}
                  hint="把 MCP 服务端与状态块插件复制到用户目录，并写进 dsh 的 profile 叠加层；重启 dsh web 后生效">
                  <span className="kbd2" onClick={() => {
                    void (integ
                      ? window.bubble.unintegrate()
                      : window.bubble.integrate()
                    ).then((r) => { setIntegMsg(r.detail); void window.bubble.integrationState().then(setIntegState) })
                  }}>{integ ? '移除集成' : '一键接入'}</span>
                </Row>
                {integMsg ? <div style={{ fontSize: 10.5, color: '#7b8494', paddingTop: 4 }}>{integMsg}</div> : null}
              </div>

              <div className="sect">
                <div className="ttl">临时截图</div>
                <Row label="存储目录" hint={integState?.screenshotDir ?? ''}>
                  <span className="kbd2" onClick={() => void window.bubble.openScreenshotDir()}>打开</span>
                </Row>
                <Row label="保留数量" hint="超过后自动删除最旧的">
                  <span className="sel2" onClick={() => {
                    const cur = config?.screenshotKeep ?? 50
                    const opts = [20, 50, 100, 200]
                    onPatch({ screenshotKeep: opts[(opts.indexOf(cur) + 1) % opts.length] })
                  }}>{config?.screenshotKeep ?? 50} 张<span className="ar">▼</span></span>
                </Row>
              </div>

              <div className="sect">
                <div className="ttl">协议</div>
                <div style={{ fontSize: 11.5, color: '#7b8494', lineHeight: 1.8 }}>
                  一元调用走 <code>POST /api/&lt;method&gt;</code>；下行事件走**两条 WebSocket**
                  （<code>/api/events.mux</code> 与 <code>/api/events.host</code>）——
                  后者承载会话新增/移除/运行状态/归档变更。
                </div>
              </div>
            </>
          ) : null}

          {false ? (
            <div className="soon">
              <div className="big">🚧</div>
              <div className="t1">{CATS.find((x) => x.id === cat)?.name} · 第二批</div>
              <div className="t2">
                {cat === 'perception'
                  ? '屏幕共享三档、采样间隔、本地屏幕日记、token 预算上限'
                  : cat === 'privacy'
                  ? '排除应用黑名单、清空屏幕日记、上传审计导出'
                  : cat === 'session'
                  ? '默认工作目录、默认模型与思考模式、首屏消息条数'
                  : 'dsh 服务地址、日志、诊断信息、重置设置'}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
