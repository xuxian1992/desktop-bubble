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
  const [prevForm, setPrevForm] = useState<FormFactor>('bubble')
  const [prevSidebar, setPrevSidebar] = useState(false)
  const snap = useSnapshot()
  const perception = usePerception()

  useEffect(() => {
    void window.bubble.getState().then(setState)
    void window.bubble.getConfig().then((c) => {
      setConfig(c)
      // 首次运行且还没走过向导 → 先检查 dsh 在不在
      if (!c.setupDone) {
        void window.bubble.probeDsh().then((p) => {
          setView(p.found ? 'chat' : 'firstrun')
          if (p.found) void window.bubble.patchConfig({ setupDone: true }).then(setConfig)
        })
      }
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
        />
      )}
      <ResizeHandles />
    </div>
  )
}
