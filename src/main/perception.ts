import { desktopCapturer, nativeImage, powerMonitor, screen } from 'electron'
import { loadConfig } from './config'
import type { NativeImage } from 'electron'

/**
 * 屏幕感知引擎（方案 §5 的 L0 / L1 / L5 落地）。
 *
 * 设计要点：**感知留在本地，token 只在值得时才花。**
 *
 *   off      —— 只能手动截图（0 token）
 *   passive  —— 本地采样 + 变化检测 + 写本地屏幕日记，**一个 token 都不花**
 *   active   —— 额外把「发生了什么」以**纯文字**形式告诉模型（仍然不发图）
 *
 * 为什么 active 也不主动发图：发图是唯一真正的开销来源。
 * 让模型先知道「14:32 出现了一个标题含『错误』的窗口」，它再决定要不要看像素 ——
 * 这一次决定的成本远低于把每帧都推过去。
 *
 * 没有 OCR / UIA（D4 决策：本机无 dotnet，不做 OCR 优先），
 * 所以 L2 用 **窗口标题** 这个零成本的文本信号替代。
 */

export type MonitorMode = 'off' | 'passive'

export interface DiaryEntry {
  t: number
  kind: 'change' | 'window' | 'tag' | 'note'
  text: string
  /** 变化帧的小缩略图（base64 JPEG）—— 这就是「屏幕 DVR」的可取回内容 */
  thumb?: string
  tokens: number
}

export interface PerceptionStats {
  samples: number
  changes: number
  uploadedFrames: number
  estTokens: number
  lastChangeAt?: number
  lastText?: string
}

const DIARY_MAX = 200
const THUMB_MAX_EDGE = 480
const CHANGE_THRESHOLD = 6 // 64 位里变了几位才算「变了」

const ERROR_WORDS = ['错误', '失败', '异常', '警告', '崩溃', '无法', 'Error', 'Exception', 'Failed', 'Crash', 'Warning']

let mode: MonitorMode = 'off'
let timer: NodeJS.Timeout | null = null
let busy = false
let lastHash = ''
let lastTitles: string[] = []
const diary: DiaryEntry[] = []
const stats: PerceptionStats = { samples: 0, changes: 0, uploadedFrames: 0, estTokens: 0 }
const listeners = new Set<() => void>()

export function onPerceptionChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function emit(): void {
  for (const l of listeners) { try { l() } catch { /* ignore */ } }
}

/* ---------------- 变化检测 ---------------- */

/** 8×8 灰度均值哈希 → 64 位串。比感知哈希简单，对屏幕内容足够用。 */
function hashOf(img: NativeImage): string {
  const small = img.resize({ width: 8, height: 8, quality: 'good' })
  const bmp = small.toBitmap() // BGRA
  const lum: number[] = []
  for (let i = 0; i < 64; i++) {
    const o = i * 4
    lum.push(bmp[o] * 0.114 + bmp[o + 1] * 0.587 + bmp[o + 2] * 0.299)
  }
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length
  let bits = ''
  for (const v of lum) bits += v > mean ? '1' : '0'
  return bits
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

function estTokens(w: number, h: number): number {
  return Math.round((w * h) / 750)
}

function push(entry: DiaryEntry): void {
  diary.push(entry)
  const cut = Date.now() - loadConfig().perceptDiaryMinutes * 60_000
  while (diary.length > 0 && (diary.length > DIARY_MAX || diary[0].t < cut)) diary.shift()
}

/** 排除的应用：命中关键词的窗口一律不记入日记（隐私设置） */
function excluded(title: string): boolean {
  const list = loadConfig().excludeApps
  if (list.length === 0) return false
  const low = title.toLowerCase()
  return list.some((k) => k.trim() && low.includes(k.trim().toLowerCase()))
}

/** 清空本地屏幕日记（隐私设置里的一键操作） */
export function clearDiary(): void {
  diary.length = 0
  stats.changes = 0
  stats.uploadedFrames = 0
  stats.estTokens = 0
  stats.lastChangeAt = undefined
  stats.lastText = undefined
  emit()
}

/* ---------------- 一次采样 ---------------- */

async function sample(): Promise<void> {
  if (busy || mode === 'off') return
  busy = true
  try {
    stats.samples++
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 64, height: 36 },
      fetchWindowIcons: false,
    })

    // ---- L0：窗口标题（纯文本，零像素成本）----
    const titles = sources.filter((s) => s.id.startsWith('window:')).map((s) => s.name).filter(Boolean)
    const first = lastTitles.length === 0
    const prev = new Set(lastTitles)
    const now = new Set(titles)
    for (const t of titles) {
      if (excluded(t)) continue
      if (!prev.has(t)) {
        const hit = ERROR_WORDS.find((w) => t.includes(w))
        // 首次采样只建立基线，不把「已经开着的窗口」全报成新窗口
        if (!first) {
          push({ t: Date.now(), kind: hit ? 'tag' : 'window', text: (hit ? '出现「' + hit + '」窗口：' : '新窗口：') + t.slice(0, 80), tokens: 0 })
        }
      }
    }
    if (!first) {
      for (const t of lastTitles) if (!now.has(t)) push({ t: Date.now(), kind: 'window', text: '窗口关闭：' + t.slice(0, 80), tokens: 0 })
    }
    lastTitles = titles

    // ---- L1：画面变化（本地哈希，仍然是零上传）----
    const screenSource = sources.find((s) => s.id.startsWith('screen:') && String(s.display_id) === String(display.id))
      ?? sources.find((s) => s.id.startsWith('screen:'))
    if (!screenSource) return
    const hash = hashOf(screenSource.thumbnail)
    if (lastHash === '') { lastHash = hash; return }
    const dist = hamming(lastHash, hash)
    if (dist < CHANGE_THRESHOLD) return
    lastHash = hash
    stats.changes++
    stats.lastChangeAt = Date.now()

    // 变化帧存一张小图进日记（本地，不发送）
    const thumbImg = screenSource.thumbnail
    const big = await fullThumb(display)
    const jpeg = big.toJPEG(52)
    const size = big.getSize()
    push({
      t: Date.now(),
      kind: 'change',
      text: '画面变化（显著度 ' + dist + '/64）',
      thumb: jpeg.toString('base64'),
      tokens: estTokens(size.width, size.height),
    })
    stats.lastText = '画面变化 ' + new Date().toLocaleTimeString()
    void thumbImg
    emit()
  } catch (err) {
    console.error('[perception] 采样失败', err)
  } finally {
    busy = false
  }
}

const fullCache = new Map<number, { at: number; img: NativeImage }>()

async function fullThumb(display: Electron.Display): Promise<NativeImage> {
  const cached = fullCache.get(display.id)
  if (cached && Date.now() - cached.at < 1500) return cached.img
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(display.bounds.width, display.bounds.height))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor * scale)),
      height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor * scale)),
    },
  })
  const s = sources.find((x) => String(x.display_id) === String(display.id)) ?? sources[0]
  fullCache.set(display.id, { at: Date.now(), img: s.thumbnail })
  return s.thumbnail
}

/* ---------------- 对外 ---------------- */

export function getMode(): MonitorMode { return mode }

export function setMode(next: MonitorMode): MonitorMode {
  mode = next
  if (timer) { clearInterval(timer); timer = null }
  if (next !== 'off') {
    lastHash = ''
    lastTitles = []
    push({ t: Date.now(), kind: 'note', text: next === 'passive' ? '开始本地感知（不上传）' : '开始感知（文字上报）', tokens: 0 })
    const ms = loadConfig().perceptSampleMs
    timer = setInterval(() => { void sample() }, ms)
    void sample()
  } else {
    push({ t: Date.now(), kind: 'note', text: '已停止感知', tokens: 0 })
  }
  emit()
  return mode
}

export function getDiary(): DiaryEntry[] { return [...diary].reverse() }

export function searchDiary(q: string, limit = 6): DiaryEntry[] {
  const needle = (q ?? '').trim().toLowerCase()
  const all = [...diary].reverse()
  if (!needle) return all.slice(0, limit)
  const hits = all.filter((e) => e.text.toLowerCase().includes(needle))
  // 关键词没命中就退回最近几条 —— 用户问「刚才那个」时通常指的就是刚刚
  return (hits.length ? hits : all).slice(0, limit)
}

export function getStats(): PerceptionStats { return { ...stats } }

export function getIdleSeconds(): number {
  try { return powerMonitor.getSystemIdleTime() } catch { return 0 }
}

/** 给状态块用的一行摘要 */
export function getHint(): string {
  if (mode === 'off') return '共享关闭 —— 不持续看屏幕；可以用 bubble_screenshot 手动看一眼（一次性）'
  const mins = Math.round(loadConfig().perceptDiaryMinutes)
  const label = '仅感知（本地，不上传）'
  const last = stats.lastChangeAt ? '，最近变化 ' + new Date(stats.lastChangeAt).toLocaleTimeString() : ''
  const recent = diary.filter((e) => e.kind === 'tag').slice(-1)[0]
  return label + '：近 ' + mins + ' 分钟 ' + stats.changes + ' 次变化' + last +
    (recent ? '，最近事件「' + recent.text.slice(0, 40) + '」' : '') +
    '。本地日记可检索（bubble_diary_search），需要像素时再用 bubble_screenshot。'
}
