import { app, BrowserWindow, screen, nativeImage } from 'electron'
import { join } from 'node:path'
import type { BubbleConfig, BubbleState, FormFactor, Rect, ResizeEdge } from '../shared/types'
import { FORM_SIZES, MIN_SIZE, MAX_SIZE, SIDEBAR_WIDTH } from '../shared/types'
import { loadConfig, saveConfig } from './config'

let win: BrowserWindow | null = null
let saveTimer: NodeJS.Timeout | null = null
let drag: { edge: ResizeEdge; start: Rect; sx: number; sy: number } | null = null
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

export function getWindow(): BrowserWindow | null {
  return win
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

/** 把矩形拉回某个显示器的工作区内（留 8px 边距） */
function clampToWorkArea(r: Rect): Rect {
  const area = screen.getDisplayMatching(r).workArea
  const width = clamp(r.width, MIN_SIZE.width, Math.min(MAX_SIZE.width, area.width))
  const height = clamp(r.height, MIN_SIZE.height, Math.min(MAX_SIZE.height, area.height))
  const x = clamp(r.x, area.x + 8, area.x + area.width - width - 8)
  const y = clamp(r.y, area.y + 8, area.y + area.height - height - 8)
  return { x, y, width, height }
}

/** 首次运行：落位到主屏右下角，避开任务栏 */
function defaultRect(cfg: BubbleConfig): Rect {
  const area = screen.getPrimaryDisplay().workArea
  const width = cfg.bounds.width
  const height = cfg.bounds.height
  return clampToWorkArea({
    x: area.x + area.width - width - 42,
    y: area.y + area.height - height - 74,
    width,
    height,
  })
}

function resolveInitialRect(cfg: BubbleConfig): Rect {
  const { x, y, width, height } = cfg.bounds
  if (typeof x === 'number' && typeof y === 'number') return clampToWorkArea({ x, y, width, height })
  return defaultRect(cfg)
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!win) return
    const b = win.getBounds()
    const display = screen.getDisplayMatching(b)
    const patch: Partial<BubbleConfig> = { bounds: b, displayId: display.id }
    saveConfig(patch)
  }, 350)
}

export function getState(): BubbleState {
  const cfg = loadConfig()
  const bounds = win ? win.getBounds() : resolveInitialRect(cfg)
  return {
    form: cfg.form, bounds, monitoring: false,
    sidebarOpen: cfg.sidebarOpen, alwaysOnTop: cfg.alwaysOnTop,
  }
}

export function createWindow(): BrowserWindow {
  const cfg = loadConfig()
  const rect = resolveInitialRect(cfg)

  win = new BrowserWindow({
    ...rect,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    maxWidth: MAX_SIZE.width,
    maxHeight: MAX_SIZE.height,
    frame: false,
    // 关掉 WS_THICKFRAME：否则 Windows 的最小跟踪尺寸会把胶囊(96×96)顶到 ~150px
    thickFrame: false,
    transparent: false,
    backgroundColor: '#16181f',
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setAlwaysOnTop(cfg.alwaysOnTop, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.once('ready-to-show', () => {
    win?.show()
    console.log('[bubble] requested=', JSON.stringify(rect), ' actual=', JSON.stringify(win?.getBounds()))
    setTimeout(() => console.log('[bubble] after 3s =', JSON.stringify(win?.getBounds())), 3000)
  })
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function pushState(): void {
  win?.webContents.send('bubble:stateChanged', getState())
}

export function setForm(form: FormFactor): BubbleState {
  const cfg = loadConfig()
  saveConfig({ form })
  if (win) {
    const cur = win.getBounds()
    const size = FORM_SIZES[form]
    const extra = cfg.sidebarOpen ? SIDEBAR_WIDTH : 0
    const next = clampToWorkArea({ x: cur.x, y: cur.y, width: size.width + extra, height: size.height })
    win.setBounds(next, true)
  }
  pushState()
  return getState()
}

/** 展开 / 收起会话侧边栏：窗口宽度加减 SIDEBAR_WIDTH，聊天区不变形 */
export function setSidebarOpen(open: boolean): BubbleState {
  const cfg = loadConfig()
  if (cfg.sidebarOpen === open) return getState()
  saveConfig({ sidebarOpen: open })
  if (win) {
    const cur = win.getBounds()
    const delta = open ? SIDEBAR_WIDTH : -SIDEBAR_WIDTH
    const width = cur.width + delta
    // 侧边栏在左：**保持右边缘不动、向左展开**，聊天区原地不动。
    // 若改成保持左边缘（向右加宽），聊天区会整体向右跳 260px —— 就是那个「闪一下」。
    const right = cur.x + cur.width
    const next = clampToWorkArea({ x: right - width, y: cur.y, width, height: cur.height })
    win.setBounds(next)
  }
  pushState()
  return getState()
}

/**
 * 用户点了关闭（✕ / Alt+F4 / 任务栏关闭）。
 *
 * 行为由设置决定：**收进托盘**（程序继续常驻）或**直接退出**。
 * 注意：气泡是无边框窗口，操作系统不提供标题栏关闭按钮 —— 所以这个动作必须由我们
 * 自己在顶栏画一个 ✕，否则用户根本没有「关闭」这个入口。
 */
export function closeBubble(): void {
  const cfg = loadConfig()
  if (cfg.closeToTray) {
    getWindow()?.hide()
    return
  }
  app.quit()
}

/** 置顶开关 */
export function setAlwaysOnTop(on: boolean): BubbleState {
  saveConfig({ alwaysOnTop: on })
  win?.setAlwaysOnTop(on, 'floating')
  pushState()
  return getState()
}

export function beginResize(edge: ResizeEdge, sx: number, sy: number): void {
  if (!win) return
  drag = { edge, start: win.getBounds(), sx, sy }
}

export function resizeTo(sx: number, sy: number): void {
  if (!win || !drag) return
  const { edge, start, sx: ox, sy: oy } = drag
  const dx = sx - ox
  const dy = sy - oy

  let width = start.width
  let height = start.height
  if (edge.includes('e')) width = start.width + dx
  if (edge.includes('w')) width = start.width - dx
  if (edge.includes('s')) height = start.height + dy
  if (edge.includes('n')) height = start.height - dy

  width = clamp(width, MIN_SIZE.width, MAX_SIZE.width)
  height = clamp(height, MIN_SIZE.height, MAX_SIZE.height)

  let x = start.x
  let y = start.y
  if (edge.includes('w')) x = start.x + start.width - width
  if (edge.includes('n')) y = start.y + start.height - height

  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
}

export function endResize(): void {
  if (!win || !drag) return
  drag = null
  scheduleSave()
  pushState()
}

export function toggleVisible(): void {
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

export function showWindow(): void {
  win?.show()
  win?.focus()
}
