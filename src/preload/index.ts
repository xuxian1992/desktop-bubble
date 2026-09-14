import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Attachment, BubbleApi, BubbleConfig, BubbleState, CapturedImage, DiaryEntryView, DshProbeView,
  FormFactor, HotkeyAction, IntegrationState, MonitorMode, PerceptionView, RuntimeStatusView,
  InboxAnswer, Rect, ResizeEdge, Snapshot,
} from '../shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)
const send = ipcRenderer.send.bind(ipcRenderer)

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: unknown, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: BubbleApi = {
  /* 窗口 */
  getState: () => invoke('bubble:getState') as Promise<BubbleState>,
  setForm: (form: FormFactor) => invoke('bubble:setForm', form) as Promise<BubbleState>,
  setSidebarOpen: (open: boolean) => invoke('bubble:setSidebarOpen', open) as Promise<BubbleState>,
  setAlwaysOnTop: (on: boolean) => invoke('bubble:setAlwaysOnTop', on) as Promise<BubbleState>,
  beginResize: (edge: ResizeEdge, x: number, y: number) => send('bubble:beginResize', edge, x, y),
  resizeTo: (x: number, y: number) => send('bubble:resizeTo', x, y),
  endResize: () => send('bubble:endResize'),
  hide: () => send('bubble:hide'),
  close: () => send('bubble:close'),
  quit: () => send('bubble:quit'),
  onStateChanged: (cb) => on('bubble:stateChanged', cb),

  /* 会话 */
  getSnapshot: () => invoke('dsh:getSnapshot') as Promise<Snapshot>,
  onSnapshot: (cb) => on('dsh:snapshot', cb),
  openSession: (id: string) => invoke('dsh:openSession', id) as Promise<void>,
  createSession: (cwd?: string) => invoke('dsh:createSession', cwd) as Promise<void>,
  renameSession: (id: string, title: string) => invoke('dsh:renameSession', id, title) as Promise<void>,
  archiveSession: (id: string) => invoke('dsh:archiveSession', id) as Promise<void>,
  forkSession: (id: string) => invoke('dsh:forkSession', id) as Promise<void>,
  prompt: (text: string, attachments?: Attachment[]) =>
    invoke('dsh:prompt', text, attachments) as Promise<void>,
  cancel: () => invoke('dsh:cancel') as Promise<void>,
  runCommand: (line: string) =>
    invoke('dsh:command', line) as Promise<{ ok: boolean; error?: string }>,
  /** 「启动 dsh」按钮 —— 不用重启气泡 */
  startDsh: () =>
    invoke('dsh:start') as Promise<{ ok: boolean; state: string; detail: string }>,
  /** 引导截图（数据 URL，渲染层读不到磁盘） */
  apiKeyGuideImage: () => invoke('guide:apiKeyImage') as Promise<string>,
  /** 一键诊断：收集 / 发送 / 存文件 */
  diagCollect: () => invoke('diag:collect') as Promise<Record<string, unknown>>,
  diagSend: (url: string) => invoke('diag:send', url) as Promise<{ ok: boolean; detail: string }>,
  diagSave: () => invoke('diag:save') as Promise<{ ok: boolean; path: string }>,
  refresh: () => invoke('dsh:refresh') as Promise<void>,
  answerInbox: (itemId: string, answer: InboxAnswer) =>
    invoke('dsh:answerInbox', itemId, answer) as Promise<void>,

  /* 工作区 */
  addWorkspace: () => invoke('dsh:addWorkspace') as Promise<void>,
  renameWorkspace: (id: string, title: string) => invoke('dsh:renameWorkspace', id, title) as Promise<void>,
  removeWorkspace: (id: string) => invoke('dsh:removeWorkspace', id) as Promise<void>,

  /* 模型 */
  selectModel: (provider: string, model: string, reasoningEffort?: string) =>
    invoke('dsh:selectModel', provider, model, reasoningEffort) as Promise<void>,

  /* 截图 */
  captureScreen: () => invoke('capture:screen') as Promise<CapturedImage | null>,
  captureRegion: () => invoke('capture:region') as Promise<CapturedImage | null>,
  finishRegion: (rect: Rect | null) => send('capture:finishRegion', rect),
  onCaptureStaged: (cb) => on('capture:staged', cb),

  /* 附件 */
  classifyPaths: (paths: string[]) => invoke('attach:classifyPaths', paths) as Promise<Attachment[]>,
  attachFromBytes: (name: string, base64: string) =>
    invoke('attach:fromBytes', name, base64) as Promise<Attachment | null>,
  pickFiles: () => invoke('attach:pick') as Promise<Attachment[]>,
  onAttachStaged: (cb) => on('attach:staged', cb),
  /** 渲染进程拿到的 File 对象 → 真实磁盘路径（粘贴与拖拽共用） */
  pathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  /* 设置 */
  getHotkeys: () => invoke('settings:getHotkeys') as Promise<Record<HotkeyAction, string>>,
  setHotkey: (action: HotkeyAction, accel: string) =>
    invoke('settings:setHotkey', action, accel) as Promise<{ ok: boolean; error?: string }>,
  getConfig: () => invoke('settings:getConfig') as Promise<BubbleConfig>,
  patchConfig: (patch: Partial<BubbleConfig>) =>
    invoke('settings:patchConfig', patch) as Promise<BubbleConfig>,

  getPerception: () => invoke('perception:get') as Promise<PerceptionView>,
  setMonitorMode: (m: MonitorMode) => invoke('perception:setMode', m) as Promise<PerceptionView>,
  diarySearch: (q: string) => invoke('perception:search', q) as Promise<DiaryEntryView[]>,
  clearDiary: () => invoke('perception:clear') as Promise<PerceptionView>,
  openDataDir: () => invoke('misc:openDataDir') as Promise<void>,
  appVersion: () => invoke('misc:appVersion') as Promise<string>,
  onPerceptionChanged: (cb) => on('perception:changed', cb),

  probeDsh: () => invoke('setup:probeDsh') as Promise<DshProbeView>,
  probeNpm: () => invoke('setup:probeNpm') as Promise<{ found: boolean; version?: string; source?: 'path' | 'portable' }>,
  probeRuntime: () => invoke('setup:probeRuntime') as Promise<RuntimeStatusView>,
  installNode: () => invoke('setup:installNode') as Promise<{ ok: boolean; detail: string; nodeExe?: string }>,
  onNodeInstallLine: (cb) => on('node:installLine', cb),
  onNodeInstallDone: (cb) => on('node:installDone', cb),
  removeNode: () => invoke('setup:removeNode') as Promise<{ ok: boolean; detail: string }>,
  nodeRuntimeDir: () => invoke('setup:nodeRuntimeDir') as Promise<string>,
  openNodeDownload: () => invoke('setup:openNodeDownload') as Promise<void>,
  reconnect: () => invoke('setup:reconnect') as Promise<boolean>,
  apiKeyState: () => invoke('setup:apiKeyState') as Promise<{ configured: boolean; writable: boolean }>,
  setApiKey: (value: string) => invoke('setup:setApiKey', value) as Promise<{ ok: boolean; error?: string }>,
  installDsh: () => invoke('setup:installDsh') as Promise<void>,
  onDshInstallLine: (cb) => on('dsh:installLine', cb),
  onDshInstallDone: (cb) => on('dsh:installDone', cb),
  integrationState: () => invoke('setup:integrationState') as Promise<IntegrationState>,
  integrate: () => invoke('setup:integrate') as Promise<{ ok: boolean; detail: string }>,
  unintegrate: () => invoke('setup:unintegrate') as Promise<{ ok: boolean; detail: string }>,
  openScreenshotDir: () => invoke('setup:openScreenshotDir') as Promise<void>,

  openExternal: (url: string) => invoke('misc:openExternal', url) as Promise<void>,
  copyText: (text: string) => invoke('misc:copyText', text) as Promise<void>,
  failedHotkeys: () => invoke('settings:failedHotkeys') as Promise<HotkeyAction[]>,
}

contextBridge.exposeInMainWorld('bubble', api)
