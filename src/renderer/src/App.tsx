import { useCallback, useEffect, useState } from 'react'
import type { BubbleConfig, BubbleState, FormFactor } from '@shared/types'
import { useSnapshot } from './hooks/useSnapshot'
import { usePerception } from './hooks/usePerception'
import { Chat } from './components/Chat'
import { Capsule } from './components/Capsule'
import { SettingsView } from './components/SettingsView'
import { FirstRun } from './components/FirstRun'
import { ResizeHandles } from './components/ResizeHandles'

export default function App() {
  const [state, setState] = useState<BubbleState | null>(null)
  const [config, setConfig] = useState<BubbleConfig | null>(null)
  const [view, setView] = useState<'chat' | 'settings' | 'firstrun'>('chat')
  /** dsh 缺失且已经过了首次运行 —— 常驻提示，否则用户永远没机会装 */
  const [needDsh, setNeedDsh] = useState(false)
  const [prevForm, setPrevForm] = useState<FormFactor>('bubble')
  const [prevSidebar, setPrevSidebar] = useState(false)
  const snap = useSnapshot()
  const perception = usePerception()

  /**
   * 查运行环境，决定要不要把「缺 dsh」摆到用户面前。
   *
   * ⚠️ 以前这段只在 `!setupDone` 时跑 —— 结果是：**向导只要走过一次**（哪怕点了「稍后再说」），
   * 之后再也不会检测，用户永远没有机会装 dsh。这是真事：有人在笔记本上装了 Node、
   * 却始终没装上 dsh，因为向导再也没出现过。
   *
   * 现在改成每次启动都查：没走过向导 → 完整向导；走过了但仍缺 dsh → 常驻提示条。
   */
  const probeEnv = useCallback(async (setupDone: boolean) => {
    const r = await window.bubble.probeRuntime()
    if (r.dsh.found) {
      setNeedDsh(false)
      if (!setupDone) void window.bubble.patchConfig({ setupDone: true }).then(setConfig)
      return
    }
    if (!setupDone) setView('firstrun')
    else setNeedDsh(true)
  }, [])

  /**
   * 把 VCP 插件自带的字体注册进来。
   *
   * 卡片里的 `font-family:'Lanxi-XXX'` 在 web 端由 dsh-raw-html 插件全局注册；
   * 气泡是另一套渲染，不注册的话字体全部退化成系统黑体 ——
   * 而字体是那些卡片最显眼的部分之一。
   *
   * 字体文件不从安装包带（55MB），直接引用插件目录里的文件。
   * 没装插件的机器拿到空名单，跳过就行 —— 那种情况本来也没有卡片要渲染。
   */
  useEffect(() => {
    void window.bubble.vcpFonts().then(({ dir, names }) => {
      if (!names.length) return
      const base = 'file:///' + dir.replace(/\\/g, '/')
      const css = names
        .map((n) => "@font-face{font-family:'" + n.name + "';src:url('" + base + '/' + n.file + "') format('woff2');font-display:swap}")
        .join('\n')
      const el = document.createElement('style')
      el.id = 'vcp-fonts'
      el.textContent = css
      document.head.appendChild(el)
      console.log('[vcp] 已注册 ' + names.length + ' 个字体')
    })
  }, [])

  useEffect(() => {
    void window.bubble.getState().then(setState)
    void window.bubble.getConfig().then((c) => {
      setConfig(c)
      void probeEnv(c.setupDone)
    })
    return window.bubble.onStateChanged(setState)
  }, [])

  const patch = useCallback((p: Partial<BubbleConfig>) => {
    void window.bubble.patchConfig(p).then(setConfig)
  }, [])

  const openSettings = useCallback(() => {
    setState((s) => {
      if (s) {
        setPrevForm(s.form)
        setPrevSidebar(s.sidebarOpen)
      }
      return s
    })
    setView('settings')
    // 设置页不显示侧边栏 —— 先收起，宽度才不会多算 260，然后切到面板形态
    void window.bubble.setSidebarOpen(false).then(() => window.bubble.setForm('panel'))
  }, [])

  const closeSettings = useCallback(() => {
    setView('chat')
    void window.bubble.setForm(prevForm).then(() => {
      if (prevSidebar) void window.bubble.setSidebarOpen(true)
    })
  }, [prevForm, prevSidebar])

  if (!state) return null

  if (view === 'firstrun') {
    return (
      <div className="shell settings">
        <FirstRun onFinish={(skip) => {
          void window.bubble.patchConfig({ setupDone: true }).then(setConfig)
          setView('chat')
          if (!skip) void window.bubble.refresh()
          // 装完再查一次：装上了就把提示条收掉
          setTimeout(() => void probeEnv(true), 800)
        }} />
        <ResizeHandles />
      </div>
    )
  }

  const compact = state.bounds.width < 220

  return (
    <div
      className={
        (view === 'settings' ? 'shell settings' : 'shell') +
        (perception && perception.mode !== 'off' ? ' mon' : '')
      }
    >
      {compact && view === 'chat' ? (
        <Capsule onExpand={() => void window.bubble.setForm('bubble')} />
      ) : view === 'settings' ? (
        <SettingsView config={config} onPatch={patch} onBack={closeSettings} dshUrl={snap?.bus.url ?? ''} />
      ) : (
        <Chat
          snap={snap}
          state={state}
          config={config}
          perception={perception}
          onOpenSettings={openSettings}
          onOpenLink={(u) => void window.bubble.openExternal(u)}
          onCopy={(t) => void window.bubble.copyText(t)}
          dshMissing={needDsh}
          onDshReady={() => void probeEnv(true)}
          onPatch={patch}
        />
      )}
      <ResizeHandles />
    </div>
  )
}
