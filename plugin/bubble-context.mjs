/**
 * bubble-context —— 让住在桌面气泡里的 agent 每轮都知道「自己现在在哪、什么状态」。
 *
 * 机制：用 dsh 官方的 `systemPrompt.context()` 注册一个**动态运行时上下文**。
 * dsh 会把它渲染成一条 plugin 来源的 user-role 快照，而不是塞进 system prompt ——
 * 后者会让 system prompt 前缀每轮都变，KV 缓存全废（见 dsh-system-prompt README 的 KV Cache 一节）。
 *
 * **只在「气泡当前正在展示的那个会话」里注入**：
 * 用户可能在终端或浏览器里同时用 dsh，那些场景下气泡这具身体并不在场，不该污染它们的上下文。
 *
 * 状态文件由气泡主进程原子写入（%APPDATA%/desktop-bubble/context.json）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'bubble-context'

/**
 * 数据目录必须和 Electron 的 app.getPath('userData') 算出同一个位置：
 *   Windows  %APPDATA%\desktop-bubble
 *   macOS    ~/Library/Application Support/desktop-bubble
 *   Linux    ~/.config/desktop-bubble
 * 允许用 DESKTOP_BUBBLE_DATA 覆盖，便于测试。
 */
const DATA_DIR =
  process.env.DESKTOP_BUBBLE_DATA ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'desktop-bubble')
    : process.platform === 'linux'
      ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'desktop-bubble')
      : join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'desktop-bubble'))
const CONTEXT_FILE = join(DATA_DIR, 'context.json')

function readContext() {
  try {
    return JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'))
  } catch {
    return null // 气泡没在跑 —— 静默降级，绝不因为读不到状态就让会话失败
  }
}

export function apply(ctx) {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'bubble:state',
      order: 120,
      text: (context) => {
        const session = context.agent?.session
        if (session === undefined) return ''
        const data = readContext()
        if (data === null) return ''
        const current = data?.data?.current?.sessionId
        if (current === undefined || current !== session.id) return '' // 气泡没在看这个会话
        console.log('[bubble-context] 注入状态块 → ' + session.id)
        return String(data.text || '')
      },
    })
  })
  console.log('[bubble-context] 已装载（状态文件 ' + CONTEXT_FILE + '）')
}
