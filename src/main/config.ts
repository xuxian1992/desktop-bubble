import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { BubbleConfig, FormFactor, HotkeyAction, MonitorMode, Rect } from '../shared/types'
import { DEFAULT_HOTKEYS, FORM_SIZES, MIN_SIZE, MAX_SIZE } from '../shared/types'

export const DEFAULTS: BubbleConfig = {
  form: 'bubble',
  bounds: { width: FORM_SIZES.bubble.width, height: FORM_SIZES.bubble.height },
  sidebarOpen: false,
  hotkeys: { ...DEFAULT_HOTKEYS },
  closeToTray: true,
  autoStart: false,
  autoLaunchDsh: true,
  alwaysOnTop: true,
  markdown: true,
  inlineLimitBytes: 200 * 1024,
  imageMaxEdge: 1280,
  integrated: false,
  defaultMonitor: 'off' as MonitorMode,
  setupDone: false,
  screenshotDir: '',
  screenshotKeep: 50,
  perceptSampleMs: 3000,
  perceptDiaryMinutes: 15,
  excludeApps: [],
}

let cache: BubbleConfig | null = null

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function normalize(raw: Partial<BubbleConfig>): BubbleConfig {
  const form: FormFactor =
    raw.form === 'capsule' || raw.form === 'bubble' || raw.form === 'panel' ? raw.form : DEFAULTS.form
  const b: Partial<Rect> = raw.bounds ?? {}
  const width = clamp(Number(b.width) || FORM_SIZES[form].width, MIN_SIZE.width, MAX_SIZE.width)
  const height = clamp(Number(b.height) || FORM_SIZES[form].height, MIN_SIZE.height, MAX_SIZE.height)

  // 老配置没有 hotkeys 字段 → 逐项补默认值，将来新增动作也不会丢用户的自定义
  const hotkeys = { ...DEFAULT_HOTKEYS }
  for (const [k, v] of Object.entries(raw.hotkeys ?? {})) {
    if (typeof v === 'string' && v.trim()) hotkeys[k as HotkeyAction] = v
  }

  // ⚠️ 先铺开 raw，再把认识的字归一化覆盖上去 —— 这样**不认识的键会被保留**。
  //
  // 为什么必须这样：旧版本的 normalize 只输出自己认识的字段，于是升级期间
  // 「旧版还在跑、新版已经写了新字段」时，旧版保存配置会把新字段**静默删掉**。
  // 实测事故：新版加的 `integrated` 被旧版抹掉 → 新版启动时误判「从没接入过」→
  // 自愈不触发 → 灵魂与状态块双双缺失，模型「失明」。
  //
  // 保留未知键后，任意版本交叉读写都不会互相损害。
  const rawMonitor = String((raw as { defaultMonitor?: unknown }).defaultMonitor ?? '')

  const out: BubbleConfig = {
    ...(raw as BubbleConfig),
    form,
    bounds: { width, height },
    sidebarOpen: raw.sidebarOpen === true,
    hotkeys,
    closeToTray: raw.closeToTray !== false,
    autoStart: raw.autoStart === true,
    autoLaunchDsh: raw.autoLaunchDsh !== false,
    alwaysOnTop: raw.alwaysOnTop !== false,
    markdown: raw.markdown !== false,
    inlineLimitBytes: Number(raw.inlineLimitBytes) || DEFAULTS.inlineLimitBytes,
    imageMaxEdge: Number(raw.imageMaxEdge) || DEFAULTS.imageMaxEdge,
    integrated: raw.integrated === true,
    // 老配置里的 'active' 要迁移成 'passive'（那一档已合并）。
    // 类型上 MonitorMode 已经没有 'active' 了，所以这里按字符串比 —— 磁盘上仍可能是旧值。
    defaultMonitor: rawMonitor === 'passive' || rawMonitor === 'active' ? 'passive' : 'off',
    setupDone: raw.setupDone === true,
    screenshotDir: typeof raw.screenshotDir === 'string' ? raw.screenshotDir : '',
    screenshotKeep: Math.max(5, Number(raw.screenshotKeep) || DEFAULTS.screenshotKeep),
    perceptSampleMs: Math.max(1000, Number(raw.perceptSampleMs) || DEFAULTS.perceptSampleMs),
    perceptDiaryMinutes: Math.max(1, Number(raw.perceptDiaryMinutes) || DEFAULTS.perceptDiaryMinutes),
    excludeApps: Array.isArray(raw.excludeApps) ? raw.excludeApps.filter((x) => typeof x === 'string') : [],
  }
  if (typeof b.x === 'number' && typeof b.y === 'number') {
    out.bounds.x = Math.round(b.x)
    out.bounds.y = Math.round(b.y)
  }
  if (typeof raw.displayId === 'number') out.displayId = raw.displayId
  if (typeof raw.lastCwd === 'string') out.lastCwd = raw.lastCwd
  return out
}

export function loadConfig(): BubbleConfig {
  if (cache) return cache
  try {
    cache = normalize(JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<BubbleConfig>)
  } catch {
    cache = normalize({})
  }
  return cache
}

/** 原子落盘：先写临时文件再 rename，崩溃不会留下半截 json */
export function saveConfig(patch: Partial<BubbleConfig>): BubbleConfig {
  // ⚠️ 基准取**磁盘上的最新内容**，而不是内存缓存。
  //
  // 原因：这个函数是「读全量 → 改一点 → 写全量」。而窗口移动/缩放也会调它保存 bounds，
  // 于是任何一次拖动窗口都会把整份内存配置刷回磁盘。
  // 如果那份缓存已经落后（比如另一个实例刚写过，或被 -Force 杀掉前的残留），
  // 就会把别人刚写的值悄悄覆盖掉 —— 实测出现过「设置里选好的值自己变回去」。
  let base: BubbleConfig
  try {
    base = normalize(JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<BubbleConfig>)
  } catch {
    base = loadConfig()   // 文件不存在或损坏，退回内存
  }
  const next = normalize({
    ...base,
    ...patch,
    bounds: { ...base.bounds, ...(patch.bounds ?? {}) },
    hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
  })
  cache = next
  const file = configPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[config] save failed:', err)
  }
  return next
}

export function configExists(): boolean {
  return existsSync(configPath())
}
