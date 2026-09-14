import { globalShortcut } from 'electron'
import type { HotkeyAction } from '../shared/types'
import { DEFAULT_HOTKEYS } from '../shared/types'
import { loadConfig, saveConfig } from './config'

export type HotkeyHandlers = Record<HotkeyAction, () => void>

const ACTIONS: HotkeyAction[] = ['toggle', 'screenshot', 'paste', 'newSession', 'region']

let handlers: HotkeyHandlers | null = null
const failed = new Set<HotkeyAction>()

/** 把用户输入归一成 Electron accelerator（'ctrl+alt+v' → 'Control+Alt+V'） */
export function normalizeAccel(input: string): string {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean)
  const mods: string[] = []
  let key = ''
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'cmdorctrl' || l === 'commandorcontrol') mods.push('CommandOrControl')
    else if (l === 'cmd' || l === 'command') mods.push('Command')
    else if (l === 'ctrl' || l === 'control') mods.push('Control')
    else if (l === 'alt') mods.push('Alt')
    else if (l === 'shift') mods.push('Shift')
    else if (l === 'super' || l === 'win' || l === 'meta') mods.push('Super')
    else if (l === 'esc') key = 'Escape'
    else if (l === 'space') key = 'Space'
    else if (l.length === 1) key = l.toUpperCase()
    else key = p.charAt(0).toUpperCase() + p.slice(1)
  }
  return [...mods, key].filter(Boolean).join('+')
}

export function getHotkeys(): Record<HotkeyAction, string> {
  return { ...loadConfig().hotkeys }
}

export function getFailed(): HotkeyAction[] {
  return [...failed]
}

/** 重新注册全部快捷键。任何一个被占用都不影响其余。 */
export function registerAll(h: HotkeyHandlers): void {
  handlers = h
  globalShortcut.unregisterAll()
  failed.clear()
  const cfg = loadConfig()
  for (const action of ACTIONS) {
    const accel = cfg.hotkeys[action]
    if (!accel) continue
    const fn = handlers[action]
    if (!fn) continue
    try {
      if (!globalShortcut.register(accel, fn)) failed.add(action)
    } catch {
      failed.add(action)
    }
  }
  if (failed.size > 0) console.warn('[hotkey] 注册失败：', [...failed].join(', '))
}

/** 单改一项：先试注册，成功才落盘；冲突时保留原值 */
export function setHotkey(action: HotkeyAction, rawAccel: string): { ok: boolean; error?: string } {
  const accel = normalizeAccel(rawAccel)
  if (!accel || !accel.includes('+')) return { ok: false, error: '至少要带一个修饰键（Ctrl / Alt / Shift）' }

  const cfg = loadConfig()
  const dup = ACTIONS.find((a) => a !== action && cfg.hotkeys[a] === accel)
  if (dup) return { ok: false, error: '已被「' + dup + '」占用' }

  const prev = cfg.hotkeys[action]
  try { globalShortcut.unregister(prev) } catch { /* ignore */ }

  let ok = false
  try {
    ok = globalShortcut.register(accel, () => handlers?.[action]?.())
  } catch {
    ok = false
  }
  if (!ok) {
    // 回滚
    try { if (handlers) globalShortcut.register(prev, handlers[action]) } catch { /* ignore */ }
    return { ok: false, error: '这个组合被系统或别的程序占用了' }
  }

  saveConfig({ hotkeys: { [action]: accel } as Record<HotkeyAction, string> })
  failed.delete(action)
  return { ok: true }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
}
