import { app } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * 前台窗口查询。
 *
 * **为什么需要**：`desktopCapturer` 抓的是整屏，会把气泡自己也拍进去 ——
 * 既浪费 token（380×560 的对话内容进了图），又可能让模型看到自己的输出而困惑。
 * 拿到前台窗口矩形后，就只抓「用户真正在看的那块」，气泡自然不在里面。
 *
 * 实现走 PowerShell + Win32（约 300ms）。没有用 FFI 是为了不引入原生依赖 ——
 * 一次性截图场景下这点延迟可以接受。
 */

export interface ForegroundWindow {
  hwnd: string
  title: string
  rect: { x: number; y: number; width: number; height: number }
}

function scriptPath(): string {
  const root = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
  return join(root, app.isPackaged ? 'fg-query.ps1' : 'resources/fg-query.ps1')
}

export function getForegroundWindow(): Promise<ForegroundWindow | null> {
  return new Promise((resolve) => {
    const done = (v: ForegroundWindow | null): void => resolve(v)
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err || !stdout) return done(null)
          const parts = String(stdout).trim().split('|')
          if (parts.length < 3) return done(null)
          const n = parts[2].split(',').map(Number)
          if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return done(null)
          if (n[2] <= 0 || n[3] <= 0) return done(null)
          done({ hwnd: parts[0], title: parts[1], rect: { x: n[0], y: n[1], width: n[2], height: n[3] } })
        },
      )
    } catch {
      done(null)
    }
  })
}

/** 前台窗口是不是气泡自己 —— 决定截图前要不要先让开 */
export function isSelfWindow(fg: ForegroundWindow | null, selfTitle: string): boolean {
  if (!fg || !fg.title) return false
  // ⚠️ 空字符串做 includes 会「恒真」，那样会把任意窗口都误判成气泡 →
  //    于是每次都白白把自己藏起来。必须先排除空标题。
  if (!selfTitle) return false
  return fg.title.includes(selfTitle) || selfTitle.includes(fg.title)
}
