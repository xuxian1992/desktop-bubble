import { app, clipboard, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Attachment, DiaryEntryView, FormFactor, HotkeyAction, InboxAnswer, IntegrationState,
  MonitorMode, PerceptionView, Rect, ResizeEdge,
} from '../shared/types'
import { clearDiary, getDiary, getMode, getStats, searchDiary, setMode as setMonitorMode } from './perception'
import { installDsh, probeDsh, probeNpm, probeRuntime } from './dsh-manager'
import { installPortableNode, nodeRuntimeDir, removePortableNode } from './node-runtime'
import { installIntegration, isIntegrated, removeIntegration, resourceRoot } from './dsh-integration'
import { ensureRunning } from './dsh/supervisor'
import { validateApiKey } from './providers'
import type { ProviderEntry } from './providers'
import { collectDiagnostics, sendDiagnostics } from './diagnostics'
import { screenshotDirOf } from './capture'
import type { SessionStore } from './store/session-store'
import { captureDisplay, finishRegion, saveTempCopy, selectRegion } from './capture'
import { attachmentFromBase64, classifyPaths, pickFiles } from './attachments'
import { getFailed, getHotkeys, setHotkey } from './hotkeys'
import { loadConfig, saveConfig } from './config'
import {
  beginResize, closeBubble, endResize, getState, getWindow, resizeTo, setAlwaysOnTop, setForm, setSidebarOpen,
  toggleVisible,
} from './window'

function toView(e: { t: number; kind: string; text: string; thumb?: string; tokens: number }): DiaryEntryView {
  return { t: e.t, kind: e.kind as DiaryEntryView['kind'], text: e.text, hasThumb: Boolean(e.thumb), tokens: e.tokens }
}

export function perceptionView(): PerceptionView {
  return { mode: getMode(), ...getStats(), diary: getDiary().map(toView) }
}

let retryHook: (() => Promise<boolean>) | null = null

/** 由 index.ts 在 boot 时注入「重连 dsh」的实现 */
export function setRetryHook(fn: () => Promise<boolean>): void {
  retryHook = fn
}

export function registerIpc(store: SessionStore): void {
  /* ---- 窗口 ---- */
  ipcMain.handle('bubble:getState', () => getState())
  ipcMain.handle('bubble:setForm', (_e, form: FormFactor) => setForm(form))
  ipcMain.handle('bubble:setSidebarOpen', (_e, open: boolean) => setSidebarOpen(open))
  ipcMain.handle('bubble:setAlwaysOnTop', (_e, on: boolean) => setAlwaysOnTop(on))
  ipcMain.on('bubble:beginResize', (_e, edge: ResizeEdge, x: number, y: number) => beginResize(edge, x, y))
  ipcMain.on('bubble:resizeTo', (_e, x: number, y: number) => resizeTo(x, y))
  ipcMain.on('bubble:endResize', () => endResize())
  ipcMain.on('bubble:hide', () => getWindow()?.hide())
  ipcMain.on('bubble:close', () => closeBubble())
  ipcMain.on('bubble:toggle', () => toggleVisible())

  /* ---- dsh 会话 ---- */
  ipcMain.handle('dsh:getSnapshot', () => store.snapshot())
  ipcMain.handle('dsh:openSession', (_e, id: string) => store.open(id))
  ipcMain.handle('dsh:createSession', (_e, cwd?: string) => store.createSession(cwd))
  ipcMain.handle('dsh:renameSession', (_e, id: string, title: string) => store.renameSession(id, title))
  ipcMain.handle('dsh:archiveSession', (_e, id: string) => store.archiveSession(id))
  ipcMain.handle('dsh:forkSession', (_e, id: string) => store.forkSession(id))
  ipcMain.handle('dsh:prompt', (_e, text: string, attachments?: Attachment[]) =>
    store.prompt(text, attachments ?? []))
  ipcMain.handle('dsh:cancel', () => store.cancel())
  // 执行一条斜杠命令（权限档位切换走这里，不是 prompt）
  ipcMain.handle('dsh:command', (_e, line: string) => store.runCommand(line))
  ipcMain.handle('dsh:refresh', () => store.syncList())
  ipcMain.handle('dsh:answerInbox', (_e, id: string, answer: InboxAnswer) => store.answerInbox(id, answer))
  ipcMain.handle('dsh:recentCwds', () => store.recentCwds())
  ipcMain.handle('dsh:selectModel', (_e, provider: string, model: string, effort?: string) =>
    store.selectModel(provider, model, effort))

  /* ---- 工作区 ---- */
  ipcMain.handle('dsh:addWorkspace', () => store.addWorkspace())
  ipcMain.handle('dsh:renameWorkspace', (_e, id: string, title: string) => store.renameWorkspace(id, title))
  ipcMain.handle('dsh:removeWorkspace', (_e, id: string) => store.removeWorkspace(id))

  /* ---- 截图 ---- */
  ipcMain.handle('capture:screen', async () => {
    try {
      const img = await captureDisplay()
      saveTempCopy(img)
      return img
    } catch (err) { console.error('[capture] 全屏失败', err); return null }
  })
  ipcMain.handle('capture:region', async () => {
    try {
      const r = await selectRegion()
      if (r) saveTempCopy(r.image)
      return r ? r.image : null
    } catch (err) {
      console.error('[capture] 框选失败', err)
      return null
    }
  })
  ipcMain.on('capture:finishRegion', (_e, rect: Rect | null) => finishRegion(rect))

  /* ---- 附件 ---- */
  ipcMain.handle('attach:classifyPaths', (_e, paths: string[]) => classifyPaths(paths ?? []))
  ipcMain.handle('attach:fromBytes', (_e, name: string, base64: string) =>
    attachmentFromBase64(name, base64))
  ipcMain.handle('attach:pick', () => pickFiles())

  /* ---- 设置 ---- */
  ipcMain.handle('settings:getHotkeys', () => getHotkeys())
  ipcMain.handle('settings:setHotkey', (_e, action: HotkeyAction, accel: string) => setHotkey(action, accel))
  ipcMain.handle('settings:getConfig', () => loadConfig())
  ipcMain.handle('settings:patchConfig', (_e, patch) => {
    const next = saveConfig(patch)
    if (patch.autoStart !== undefined) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.autoStart, args: ['--hidden'] })
      } catch (err) { console.error('[settings] 设置开机自启失败', err) }
    }
    return next
  })
  ipcMain.handle('settings:failedHotkeys', () => getFailed())

  /* ---- 屏幕感知 ---- */
  ipcMain.handle('perception:get', () => perceptionView())
  ipcMain.handle('perception:setMode', (_e, m: MonitorMode) => {
    setMonitorMode(m)
    return perceptionView()
  })
  ipcMain.handle('perception:search', (_e, q: string) => searchDiary(q).map(toView))
  ipcMain.handle('perception:clear', () => { clearDiary(); return perceptionView() })

  /* ---- 安装与集成 ---- */
  ipcMain.handle('setup:probeDsh', () => probeDsh())
  ipcMain.handle('setup:probeNpm', () => probeNpm())
  ipcMain.handle('setup:probeRuntime', () => probeRuntime())
  ipcMain.handle('setup:installNode', async (e) => {
    const r = await installPortableNode((line) => {
      if (!e.sender.isDestroyed()) e.sender.send('node:installLine', line)
    })
    if (!e.sender.isDestroyed()) e.sender.send('node:installDone', r)
    return r
  })
  ipcMain.handle('setup:removeNode', () => removePortableNode())
  ipcMain.handle('setup:nodeRuntimeDir', () => nodeRuntimeDir())

  /* ---- 引导：让用户能自己把 dsh 弄起来 / 填 Key ---- */

  // 「启动 dsh」按钮 —— 不用重启气泡
  ipcMain.handle('dsh:start', async () => {
    const s = await ensureRunning()
    return { ok: s.state === 'ready', state: s.state, detail: s.detail ?? '' }
  })

  // 引导截图（数据 URL —— 渲染层在沙箱里读不到磁盘）
  /* ---- 一键诊断 ---- */

  ipcMain.handle('diag:collect', () => collectDiagnostics())

  ipcMain.handle('diag:send', (_e, url: string) => sendDiagnostics(url))

  // 存成文件（发不了网的时候用这个，手动传给我也一样）
  ipcMain.handle('diag:save', async () => {
    const d = await collectDiagnostics()
    const dir = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'diag-' + Date.now() + '.json')
    writeFileSync(f, JSON.stringify(d, null, 2), 'utf8')
    void shell.showItemInFolder(f)
    return { ok: true, path: f }
  })

  ipcMain.handle('guide:apiKeyImage', () => {
    try {
      const p = join(resourceRoot(), 'resources', 'guide-apikey.png')
      return 'data:image/png;base64,' + readFileSync(p).toString('base64')
    } catch {
      return ''
    }
  })
  ipcMain.handle('setup:reconnect', async () => (retryHook ? await retryHook() : false))
  ipcMain.handle('setup:apiKeyState', () => store.credentialConfigured('DEEPSEEK_API_KEY'))
  ipcMain.handle('setup:setApiKey', (_e, value: string) => {
    const v = String(value ?? '').trim()
    if (v.length < 8) return { ok: false, error: '看起来不像一个密钥' }
    return store.setCredential('DEEPSEEK_API_KEY', v)
  })
  /* ---- 供应商 / 模型 ---- */

  ipcMain.handle('provider:list', () => store.listProviders())

  ipcMain.handle('provider:discover', (_e, settingsNs: string, provider: string) =>
    store.discoverModels(settingsNs, provider),
  )

  // ⚠️ 引用名要先问 dsh（profile 的 apiKeyEnv），不能硬推导 ——
  //    内置的 deepseek-official 用的是 DEEPSEEK_API_KEY，推导会得到错的名字。
  /**
   * VCP 插件的字体目录。
   *
   * 不从安装包带字体 —— 那是 55MB，而**装了 VCP 的机器上本来就有**。
   * 没装的用户也用不到 VCP 卡片，字体也就无从谈起。
   * 所以这里只负责「找到就告诉你，找不到就拉倒」。
   */
  ipcMain.handle('setup:vcpFonts', () => {
    const dir = join(homedir(), '.dsh', 'plugins', 'dsh-raw-html', 'assets', 'fonts')
    try {
      const names = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.woff2'))
        .map((f) => ({ name: f.replace(/\.woff2$/i, ''), file: f }))
      return { dir, names }
    } catch {
      return { dir, names: [] }
    }
  })

  ipcMain.handle('provider:detail', (_e, p: ProviderEntry) => store.readProviderDetail(p))

  ipcMain.handle('provider:setField', (_e, ns: string, path: string[], value: unknown) =>
    store.setSetting(ns, path, value),
  )

  ipcMain.handle('provider:keyState', (_e, p: ProviderEntry) =>
    store.resolveApiKeyEnv(p).then((ref) => store.describeCredential(ref)),
  )

  ipcMain.handle('provider:setKey', async (_e, p: ProviderEntry, value: string) => {
    // 格式校验放在写入之前 —— 免得白跑一趟，也免得把一个错的密钥存进去
    const v = validateApiKey(String(value ?? ''))
    if (!v.ok) return { ok: false, error: v.error }
    const ref = await store.resolveApiKeyEnv(p)
    return store.setCredential(ref, String(value).trim())
  })

  ipcMain.handle('setup:openNodeDownload', async () => { await shell.openExternal('https://nodejs.org/zh-cn/download') })
  ipcMain.handle('setup:installDsh', (e) => {
    installDsh(
      (line) => { if (!e.sender.isDestroyed()) e.sender.send('dsh:installLine', line) },
      (ok, detail) => { if (!e.sender.isDestroyed()) e.sender.send('dsh:installDone', { ok, detail }) },
    )
  })
  ipcMain.handle('setup:integrationState', (): IntegrationState => ({
    integrated: isIntegrated(),
    screenshotDir: screenshotDirOf(),
    dshHome: process.env.DSH_HOME || '',
  }))
  ipcMain.handle('setup:integrate', async () => {
    const r = await installIntegration()
    if (r.ok) saveConfig({ integrated: true })
    return r
  })
  ipcMain.handle('setup:unintegrate', () => {
    const r = removeIntegration()
    saveConfig({ integrated: false })
    return r
  })
  ipcMain.handle('setup:openScreenshotDir', async () => {
    const dir = screenshotDirOf()
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    await shell.openPath(dir)
  })

  /* ---- 杂项 ---- */
  ipcMain.handle('misc:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle('misc:openDataDir', async () => { await shell.openPath(app.getPath('userData')) })
  ipcMain.handle('misc:appVersion', () => app.getVersion())
  ipcMain.handle('misc:copyText', async (_e, text: string) => {
    try { await clipboard.writeText(String(text ?? '')) } catch (err) { console.error('[misc] 复制失败', err) }
  })
}
