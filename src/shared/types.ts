/** 气泡形态与窗口约束 —— 主进程与渲染进程共用 */

export type FormFactor = 'capsule' | 'bubble' | 'panel'

export const FORM_SIZES: Record<FormFactor, { width: number; height: number }> = {
  capsule: { width: 96, height: 96 },
  bubble: { width: 380, height: 560 },
  panel: { width: 720, height: 640 },
}

/** 侧边栏展开时给窗口额外加的宽度（聊天区 380 保持不变形） */
export const SIDEBAR_WIDTH = 260

export const MIN_SIZE = { width: 96, height: 96 }
export const MAX_SIZE = { width: 1180, height: 900 }

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface Rect { x: number; y: number; width: number; height: number }

/* ---------------- 快捷键 ---------------- */

export type HotkeyAction = 'toggle' | 'screenshot' | 'paste' | 'newSession' | 'region'

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggle: '唤起 / 隐藏气泡',
  screenshot: '截图提问（整个屏幕）',
  paste: '粘贴文件到气泡',
  newSession: '新建会话',
  region: '框选截图',
}

/**
 * 默认快捷键。用 CommandOrControl 而不是写死 Control ——
 * Electron 会把它在 macOS 上解析成 ⌘、在 Windows 上解析成 Ctrl。
 */
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggle: 'CommandOrControl+Alt+Space',
  screenshot: 'CommandOrControl+Alt+S',
  paste: 'CommandOrControl+Alt+V',
  newSession: 'CommandOrControl+Alt+N',
  region: 'CommandOrControl+Alt+A',
}

/* ---------------- 配置 ---------------- */

export interface BubbleConfig {
  form: FormFactor
  bounds: Partial<Rect> & { width: number; height: number }
  displayId?: number
  /** 会话侧边栏是否展开（默认收起） */
  sidebarOpen: boolean
  hotkeys: Record<HotkeyAction, string>
  /** 关闭按钮：收进托盘 / 直接退出 */
  closeToTray: boolean
  /** 开机自动启动 */
  autoStart: boolean
  autoLaunchDsh: boolean,
  /** 窗口置顶 */
  alwaysOnTop: boolean
  /** Markdown 渲染开关 */
  markdown: boolean,
  /** 小文件内联阈值（字节） */
  inlineLimitBytes: number,
  /** 图片压缩长边上限 */
  imageMaxEdge: number
  /**
   * 是否已经接入过 dsh。
   *
   * 用途：卸载会撤掉集成（必须，否则残留插件路径会让 dsh 启动报错），但重装不会自动恢复。
   * 记下这个标记，启动时就能「缺什么补什么」——用户不必每次更新版本后手动点一次「一键接入」。
   */
  integrated: boolean
  /** 首次运行向导是否已完成（用户点过「稍后」也算完成） */
  setupDone: boolean
  /** 截图临时目录（留空则用系统临时目录下的 desktop-bubble） */
  screenshotDir: string
  /** 临时截图保留数量上限 */
  screenshotKeep: number
  /**
   * 每次启动时的默认监听档位。
   *
   * 与「当前档位」刻意分开：这里落盘的是**默认值**，由用户在设置里选定；
   * 而运行中的当前档位只存在内存里，随时可以在气泡顶部的 🖥 里临时改。
   * 这样既不用每次开机重新点，也不会有「偷偷恢复了监控」的问题 ——
   * 恢复成什么是用户自己事先定好的。
   */
  defaultMonitor: MonitorMode
  /** 感知采样间隔（毫秒） */
  perceptSampleMs: number
  /** 本地屏幕日记保留分钟数 */
  perceptDiaryMinutes: number
  /** 排除的应用关键词（命中窗口标题就不记录） */
  excludeApps: string[],
  lastCwd?: string
}

/* ---------------- 附件 ---------------- */

export type Attachment =
  | {
      kind: 'image'
      id: string
      name: string
      label: string
      base64: string
      mediaType: 'image/jpeg'
      width: number
      height: number
      bytes: number
      sourceWidth: number
      sourceHeight: number
    }
  | { kind: 'text'; id: string; name: string; path: string; bytes: number; content: string }
  | { kind: 'path'; id: string; name: string; path: string; bytes: number }

/** 一次截图的产物（已按 token 纪律压缩过） */
export interface CapturedImage {
  base64: string
  mediaType: 'image/jpeg'
  width: number
  height: number
  bytes: number
  /** 给用户看的来源说明，如「框选 640×360」 */
  label: string
  sourceWidth: number
  sourceHeight: number
}

/* ---------------- 聊天视图行 ---------------- */

export type ChatRow =
  | { kind: 'user'; id: string; text: string; time: number; hasImage?: boolean; attachCount?: number }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string; time: number; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'done' | 'error'; preview?: string; time: number }
  | { kind: 'notice'; id: string; text: string; time: number }

/* ---------------- 会话与工作区 ---------------- */

export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: number
  createdAt?: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  parentSessionId?: string
  isSubagent: boolean
  /** 给侧边栏的状态徽标用（快照里派生，store 内部不存） */
  status?: SessionStatus
  subagentsRunning?: number
}

export type SessionStatus =
  | 'running' | 'idle' | 'waitingApproval' | 'waitingAnswer' | 'planReview' | 'completed'

export interface WorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface InboxItem {
  /** 审批 = approvalId；提问 = questionRpcId（应答时要回显） */
  id: string
  sessionId: string
  sessionTitle: string
  kind: 'approval' | 'question'
  toolName?: string
  reason?: string
  questions?: Array<{
    id: string
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  time: number
}

export interface TokenStats { input: number; output: number; cacheRead: number }
export interface ContextStats { used: number; window: number }

export interface SessionView {
  sessionId: string
  title: string
  cwd?: string
  running: boolean
  rows: ChatRow[]
  loaded: boolean
  loading: boolean
  error?: string
  hasMore: boolean
  tokens?: TokenStats
  context?: ContextStats
  permissions?: PermissionStats
}

/* ---------------- 权限档位 ---------------- */

/**
 * dsh 的「权限档位」：把 sandbox 模式与审批策略打包成一个用户看得懂的名字。
 *
 * 会话创建时就钉死了，之后改只影响那个会话（不是全局设置）——
 * 所以它读的是会话投影，写的是发一条 /permission 命令。
 */
export interface PermissionOption { value: string; name: string }

export interface PermissionStats {
  options: PermissionOption[]
  currentValue: string
}

/* ---------------- 屏幕感知 ---------------- */

export type MonitorMode = 'off' | 'passive'

export const MONITOR_LABELS: Record<MonitorMode, { name: string; desc: string }> = {
  off: { name: '关闭', desc: '只能手动截图，0 token' },
  passive: { name: '仅感知', desc: '本地检测 + 屏幕日记，不上传，0 token' },
  // 曾经有第三档「主动」：把摘要写进状态块。
  // 但那个注入是**每轮固定开销**，而绝大多数轮次没有值得说的事 —— 已合并回「仅感知」，
  // 改为「平时零成本记录，需要时查 bubble_diary_search」。
  // 旧配置里遗留的 'active' 会在 config.normalize 里被迁移成 'passive'。
}

export interface DiaryEntryView {
  t: number
  kind: 'change' | 'window' | 'tag' | 'note'
  text: string
  hasThumb: boolean
  tokens: number
}

export interface PerceptionView {
  mode: MonitorMode
  samples: number
  changes: number
  uploadedFrames: number
  estTokens: number
  lastChangeAt?: number
  diary: DiaryEntryView[]
}

/* ---------------- 模型目录 ---------------- */

export interface ModelEffort { id: string; name: string }
export interface ModelOption { id: string; name: string; efforts?: ModelEffort[]; defaultEffort?: string }
export interface ModelGroup { id: string; name: string; models: ModelOption[] }
export interface ModelCatalogView {
  current: { provider: string; model: string; reasoningEffort?: string }
  groups: ModelGroup[]
}

/* ---------------- 快照 ---------------- */

export type BusState = 'starting' | 'ready' | 'error'

export interface Snapshot {
  bus: { state: BusState; url: string; owned: boolean; detail?: string }
  sessions: SessionSummary[]
  workspaces: WorkspaceSummary[]
  subagentCount: number,
  current: SessionView | null
  inbox: InboxItem[]
  catalog: ModelCatalogView | null
}

export interface BubbleState {
  form: FormFactor
  bounds: Rect
  monitoring: boolean
  sidebarOpen: boolean
  alwaysOnTop: boolean
}

export interface DshProbeView { found: boolean; version?: string; command?: string; source: string }

export interface RuntimeStatusView {
  node: { found: boolean; version?: string; portable: boolean }
  npm: { found: boolean; version?: string; portable: boolean }
  dsh: DshProbeView
  portableInstalled: boolean
}

export interface IntegrationState {
  integrated: boolean
  screenshotDir: string
  dshHome: string
}

export type InboxAnswer =
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' }
  | { kind: 'question'; selected: string[]; custom?: string }

export interface BubbleApi {
  /* 窗口 */
  getState(): Promise<BubbleState>
  setForm(form: FormFactor): Promise<BubbleState>
  setSidebarOpen(open: boolean): Promise<BubbleState>
  setAlwaysOnTop(on: boolean): Promise<BubbleState>
  beginResize(edge: ResizeEdge, screenX: number, screenY: number): void
  resizeTo(screenX: number, screenY: number): void
  endResize(): void
  hide(): void
  /** 关闭：按「关闭按钮行为」设置决定收进托盘还是退出 */
  close(): void
  quit(): void
  onStateChanged(cb: (state: BubbleState) => void): () => void

  /* 会话 */
  getSnapshot(): Promise<Snapshot>
  onSnapshot(cb: (snap: Snapshot) => void): () => void
  openSession(sessionId: string): Promise<void>
  createSession(cwd?: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  forkSession(sessionId: string): Promise<void>
  prompt(text: string, attachments?: Attachment[]): Promise<void>
  cancel(): Promise<void>
  /** 执行一条斜杠命令（权限档位切换走这里 —— 实测 prompt 发文本不会执行命令） */
  runCommand(line: string): Promise<{ ok: boolean; error?: string }>
  refresh(): Promise<void>
  answerInbox(itemId: string, answer: InboxAnswer): Promise<void>

  /* 工作区 */
  addWorkspace(): Promise<void>
  renameWorkspace(workspaceId: string, title: string): Promise<void>
  removeWorkspace(workspaceId: string): Promise<void>

  /* 模型 */
  selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void>

  /* 截图 */
  captureScreen(): Promise<CapturedImage | null>
  captureRegion(): Promise<CapturedImage | null>
  finishRegion(rect: Rect | null): void
  onCaptureStaged(cb: (img: CapturedImage) => void): () => void

  /* 附件 */
  classifyPaths(paths: string[]): Promise<Attachment[]>
  attachFromBytes(name: string, base64: string): Promise<Attachment | null>
  pickFiles(): Promise<Attachment[]>
  onAttachStaged(cb: (items: Attachment[]) => void): () => void
  pathForFile(file: File): string

  /* 设置 */
  getHotkeys(): Promise<Record<HotkeyAction, string>>
  setHotkey(action: HotkeyAction, accel: string): Promise<{ ok: boolean; error?: string }>
  getConfig(): Promise<BubbleConfig>
  patchConfig(patch: Partial<BubbleConfig>): Promise<BubbleConfig>

  /* 屏幕感知 */
  getPerception(): Promise<PerceptionView>
  setMonitorMode(mode: MonitorMode): Promise<PerceptionView>
  diarySearch(query: string): Promise<DiaryEntryView[]>
  clearDiary(): Promise<PerceptionView>
  openDataDir(): Promise<void>
  appVersion(): Promise<string>
  onPerceptionChanged(cb: (p: PerceptionView) => void): () => void

  /* 安装与集成 */
  probeDsh(): Promise<DshProbeView>
  probeNpm(): Promise<{ found: boolean; version?: string; source?: 'path' | 'portable' }>
  /** 一次探清 node / npm / dsh 三样东西有没有、是不是我们帮装的 */
  probeRuntime(): Promise<RuntimeStatusView>
  /** 下载并解压便携版 Node.js（约 34MB） */
  installNode(): Promise<{ ok: boolean; detail: string; nodeExe?: string }>
  onNodeInstallLine(cb: (line: string) => void): () => void
  onNodeInstallDone(cb: (r: { ok: boolean; detail: string; nodeExe?: string }) => void): () => void
  removeNode(): Promise<{ ok: boolean; detail: string }>
  nodeRuntimeDir(): Promise<string>
  openNodeDownload(): Promise<void>
  reconnect(): Promise<boolean>
  apiKeyState(): Promise<{ configured: boolean; writable: boolean }>
  setApiKey(value: string): Promise<{ ok: boolean; error?: string }>
  installDsh(): Promise<void>
  onDshInstallLine(cb: (line: string) => void): () => void
  onDshInstallDone(cb: (r: { ok: boolean; detail: string }) => void): () => void
  integrationState(): Promise<IntegrationState>
  integrate(): Promise<{ ok: boolean; detail: string }>
  unintegrate(): Promise<{ ok: boolean; detail: string }>
  openScreenshotDir(): Promise<void>

  /* 杂项 */
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  failedHotkeys(): Promise<HotkeyAction[]>
}
