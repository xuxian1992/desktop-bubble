import { app, BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadConfig } from './config'
import { getForegroundWindow, isSelfWindow } from './foreground'
import { getWindow } from './window'
import type { NativeImage } from 'electron'
import { join } from 'node:path'

/**
 * 截图模块。
 *
 * token 纪律（方案 §5 L4）：**绝不把原图丢给模型**。
 * 长边压到 1280、JPEG q=62 —— 一张 1920×1080 全屏从 ~1100 token 降到 ~350 左右。
 */
const MAX_EDGE = 1280
const JPEG_QUALITY = 62

export interface CapturedImage {
  /** prompt 里直接内联的 base64（不带 data: 前缀） */
  base64: string
  mediaType: 'image/jpeg'
  width: number
  height: number
  bytes: number
  label: string
  /** 裁剪前原始尺寸，用于给用户看「压缩了多少」 */
  sourceWidth: number
  sourceHeight: number
}

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * 把截图另存一份到临时目录。
 * 用途：① 用户可在设置里看到/打开这些图；② 需要时可按路径引用而不是重新编码。
 * 目录可在设置里改（screenshotDir），留空则用系统临时目录下的 desktop-bubble。
 */
export function saveTempCopy(img: CapturedImage): string | undefined {
  try {
    const cfg = loadConfig()
    const dir = cfg.screenshotDir && cfg.screenshotDir.trim()
      ? cfg.screenshotDir.trim()
      : join(app.getPath('temp'), 'desktop-bubble')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const name = 'shot-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + img.width + 'x' + img.height + '.jpg'
    const file = join(dir, name)
    writeFileSync(file, Buffer.from(img.base64, 'base64'))
    pruneTemp(dir, Math.max(5, cfg.screenshotKeep))
    return file
  } catch (err) {
    console.error('[capture] 存临时截图失败', err)
    return undefined
  }
}

function pruneTemp(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('shot-') && f.endsWith('.jpg'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) rmSync(join(dir, f), { force: true })
  } catch { /* 清理失败不影响主流程 */ }
}

export function screenshotDirOf(): string {
  const cfg = loadConfig()
  return cfg.screenshotDir && cfg.screenshotDir.trim()
    ? cfg.screenshotDir.trim()
    : join(app.getPath('temp'), 'desktop-bubble')
}

function fit(img: NativeImage, maxEdge: number): NativeImage {
  const size = img.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest <= maxEdge) return img
  const scale = maxEdge / longest
  return img.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: 'good',
  })
}

function encode(img: NativeImage, label: string, source: { width: number; height: number }): CapturedImage {
  const fitted = fit(img, MAX_EDGE)
  const buf = fitted.toJPEG(JPEG_QUALITY)
  const size = fitted.getSize()
  return {
    base64: buf.toString('base64'),
    mediaType: 'image/jpeg',
    width: size.width,
    height: size.height,
    bytes: buf.length,
    label,
    sourceWidth: source.width,
    sourceHeight: source.height,
  }
}

/** 抓取某个显示器（含缩放因子处理），point 缺省时用光标所在的显示器 */
async function grabDisplay(point?: { x: number; y: number }): Promise<{ img: NativeImage; display: Electron.Display }> {
  const display = point ? screen.getDisplayNearestPoint(point) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  })
  if (sources.length === 0) throw new Error('没有可用的屏幕源')
  const match = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
  return { img: match.thumbnail, display }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type CaptureScope = 'foreground' | 'screen'

/**
 * 截图。
 *
 * **默认只抓前台窗口，而不是整屏** —— 这一步同时解决三个问题：
 *
 *  1. **拍不到自己**：气泡是置顶窗口，抓整屏必然把它拍进去（380×560 的对话内容），
 *     既浪费 token，又可能让模型看到自己的输出而困惑。抓前台窗口自然避开。
 *  2. **更省 token**：一个 1200×800 的窗口比 1920×1080 整屏小得多。
 *  3. **更准**：模型看到的就是用户正在看的东西，而不是桌面图标和任务栏。
 *
 * 如果前台恰好是气泡自己（用户正在气泡里打字），就先把它收起来，
 * 取它背后那个窗口，截完再恢复 —— 用户不会察觉。
 */
/**
 * 截图。**分视觉范围走不同路径** —— 目标都是「气泡不出现在图里，但用户完全不受影响」。
 *
 *  | 要看的东西   | 做法                          | 气泡 | 气泡背后的内容 |
 *  |------------|------------------------------|------|--------------|
 *  | 某个窗口/应用 | desktopCapturer 窗口源        | 不出现 | **原样可见**   |
 *  | 整个桌面     | 抓屏 + 采样瞬间开内容保护        | 不出现 | 被涂黑        |
 *
 * 窗口源这条路之所以干净，是因为 Windows 上 Chromium 用 Windows.Graphics.Capture，
 * 它只拍该窗口**自己的合成表面**，压在上面的窗口天然进不来。
 *
 * 桌面那条必须用 `setContentProtection`（Windows 的 WDA）：
 * 窗口对**用户仍然可见、可交互**，但对抓屏 API 不可见 —— 这正是「不影响用户使用气泡」
 * 的要求。代价是 Electron 用的是 WDA_MONITOR，被排除的区域会**涂黑**而不是透出背后内容。
 *
 * ⚠️ 千万不要用 hide() 来规避：那会让用户正看着的气泡凭空消失，是打扰。
 */
export async function captureDisplay(
  point?: { x: number; y: number },
  scope: CaptureScope = 'foreground',
): Promise<CapturedImage> {
  const self = getWindow()
  const selfTitle = self?.getTitle() || '桌面气泡助手'

  // —— 路径 A：只看某个窗口 —— 优先走窗口源，气泡天然进不来，背后内容还完整 ——
  if (scope === 'foreground') {
    const fg = await getForegroundWindow()
    if (fg && fg.title && !isSelfWindow(fg, selfTitle)) {
      try {
        return await captureWindow(fg.title)
      } catch {
        /* 找不到就退回抓屏裁剪 */
      }
    }
  }

  // —— 路径 B：整个桌面 —— 抓屏，但采样那一瞬间开内容保护 ——
  // 用户在屏幕上照常看得见气泡、照常能点，只有「抓屏 API」看不见它。
  const protect = self?.setContentProtection.bind(self)
  try {
    protect?.(true)
    await sleep(120)                 // 等 DWM 把排除属性生效
    const { img, display } = await grabDisplay(point)
    return encode(img, '屏幕 ' + display.bounds.width + '×' + display.bounds.height, img.getSize())
  } finally {
    protect?.(false)                 // 立刻恢复，免得用户自己截屏时气泡也消失
  }
}

/**
 * 窗口名归一化：只留字母/数字/汉字，去掉空白、标点、不可见字符。
 *
 * ⚠️ 必须这么做：Win32 拿到的标题和 desktopCapturer 的窗口名**经常差一个不可打印字符**，
 * 实测 Edge 的标题里有个位置 Win32 读出 `?`、而窗口源是正常空格 ——
 * 直接 includes 就匹配不上，于是静默回退，路径 A 永远不生效。
 */
function normTitle(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

/** 从候选窗口源里挑最像 titlePart 的那个 */
function pickWindowSource<T extends { name: string }>(sources: T[], titlePart: string): T | undefined {
  const needle = normTitle(titlePart)
  if (!needle) return sources[0]
  // 1) 归一化后完全相同或互相包含
  const exact = sources.find((s) => {
    const n = normTitle(s.name)
    return n === needle || n.includes(needle) || needle.includes(n)
  })
  if (exact) return exact
  // 2) 退而求其次：公共前缀最长者（要求至少 6 个字符，免得乱配）
  let best: T | undefined
  let bestLen = 0
  for (const s of sources) {
    const n = normTitle(s.name)
    let i = 0
    while (i < n.length && i < needle.length && n[i] === needle[i]) i++
    if (i > bestLen) { bestLen = i; best = s }
  }
  return bestLen >= 6 ? best : undefined
}

/**
 * 抓「某个窗口」而不是抓屏。
 *
 * 关键问题：Windows 上按窗口抓，到底会不会把**压在上面的其它窗口**（比如气泡）也拍进来？
 * 老式的 GDI BitBlt 会；新一代的 Windows.Graphics.Capture 只拍该窗口自己的表面。
 * 这决定了「看某个应用」时要不要额外处理 —— 所以这里如实保留原始行为，不做任何美化。
 */
export async function captureWindow(titlePart: string): Promise<CapturedImage> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 2560, height: 1600 },
    fetchWindowIcons: false,
  })
  if (sources.length === 0) throw new Error('没有可用的窗口源')
  const match = pickWindowSource(sources, titlePart)
  if (!match) {
    throw new Error('没找到窗口：' + (titlePart.trim() || '(空)') + '；可选 ' + sources.slice(0, 8).map((s) => s.name).join(' / '))
  }
  const size = match.thumbnail.getSize()
  return encode(match.thumbnail, match.name.slice(0, 60), size)
}

export interface RegionResult {
  image: CapturedImage
  /** 用户选的区域在显示器上的位置 */
  rect: Rect
  display: { id: number; bounds: Rect }
}

let overlay: BrowserWindow | null = null
let resolveRegion: ((r: Rect | null) => void) | null = null

export function isSelectingRegion(): boolean {
  return overlay !== null
}

/** 覆盖层回报选择结果（或 null 表示取消） */
export function finishRegion(rect: Rect | null): void {
  const done = resolveRegion
  resolveRegion = null
  overlay?.close()
  overlay = null
  done?.(rect)
}

/**
 * 框选：在当前显示器上盖一层半透明覆盖层，用户拖出矩形。
 * 覆盖层先隐藏再截图，否则会把自己拍进去。
 */
export function selectRegion(): Promise<RegionResult | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return new Promise<RegionResult | null>((resolve) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    overlay = win
    win.setAlwaysOnTop(true, 'screen-saver')
    resolveRegion = (rect) => {
      void (async () => {
        if (!rect || rect.width < 8 || rect.height < 8) {
          resolve(null)
          return
        }
        try {
          // 隐藏覆盖层 + 让出两帧，确保截图里没有选择框
          win.hide()
          await new Promise((r) => setTimeout(r, 160))
          const { img } = await grabDisplay({ x: display.bounds.x, y: display.bounds.y })
          const size = img.getSize()
          const sx = size.width / display.bounds.width
          const sy = size.height / display.bounds.height
          const cropRect = {
            x: Math.max(0, Math.round(rect.x * sx)),
            y: Math.max(0, Math.round(rect.y * sy)),
            width: Math.min(size.width, Math.round(rect.width * sx)),
            height: Math.min(size.height, Math.round(rect.height * sy)),
          }
          const cropped = img.crop(cropRect)
          resolve({
            image: encode(cropped, '框选 ' + Math.round(rect.width) + '×' + Math.round(rect.height), { width: cropRect.width, height: cropRect.height }),
            rect,
            display: { id: display.id, bounds: display.bounds },
          })
        } catch (err) {
          console.error('[capture] 框选截图失败', err)
          resolve(null)
        }
      })()
    }
    void win.loadFile(join(__dirname, '../renderer/region.html'))
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      overlay = null
      if (resolveRegion === null) return
      resolveRegion = null
      resolve(null)
    })
  })
}
