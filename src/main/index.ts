import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { perceptionView, registerIpc, setRetryHook } from './ipc'
import { getHint, getMode, onPerceptionChange, searchDiary, setMode as setMonitorMode } from './perception'
import { startControlServer, stopControlServer } from './control'
import { writeContextFile } from './context'
import { captureDisplay, captureWindow, selectRegion } from './capture'
import { attachmentsFromClipboard } from './attachments'
import { DshClient } from './dsh/client'
import { ensureRunning, stopOwned } from './dsh/supervisor'
import { registerAll, unregisterAll } from './hotkeys'
import { SessionStore } from './store/session-store'
import type { FormFactor, MonitorMode } from '../shared/types'
import { closeBubble, createWindow, getWindow, getState, setForm, showWindow, toggleVisible } from './window'
import { loadConfig } from './config'
import { ensureIntegration } from './dsh-integration'


const DSH_URL = (process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/$/, '')

let tray: Tray | null = null
let quitting = false
let client: DshClient | null = null
let store: SessionStore | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => { void boot() })
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => {
    unregisterAll()
    stopOwned()
    stopControlServer()
    client?.close()
  })
  app.on('window-all-closed', () => { /* 托盘常驻 */ })
}

/** 把一批附件送到渲染进程的输入框（截图 / 粘贴共用同一条路） */
function stageAttachments(items: unknown[]): void {
  if (items.length === 0) return
  showWindow()
  getWindow()?.webContents.send('attach:staged', items)
}

async function boot(): Promise<void> {
  app.setAppUserModelId('com.desktopbubble.app')
  createWindow()

  // 应用用户在「设置 → 屏幕感知 → 启动时的默认档位」里选的档位。
  // 注意：这是**用户事先明确定好**的默认值，不是程序自作主张恢复监控。
  const dm = loadConfig().defaultMonitor
  if (dm !== 'off') {
    setMonitorMode(dm)
    console.log('[boot] 屏幕感知按默认档位启动：' + dm)
  }

  // 自愈：更新版本 = 卸载 + 重装。卸载必须撤掉对 dsh 的集成，但重装不会自动恢复 ——
  // 结果是模型既收不到状态块、也没有灵魂解释它，表现就是「明明开着屏幕共享却忘了自己有视觉」。
  // 只要用户接入过一次（config.integrated），就每次启动检查并补回。
  try {
    if (loadConfig().integrated) {
      const r = await ensureIntegration()
      console.log('[boot] dsh 集成：' + r.detail)
    }
  } catch (err) {
    console.error('[boot] 集成自检失败', err)
  }

  const win = getWindow()
  win?.on('close', (e) => {
    if (quitting) return
    // ⚠️ 这里原来是无条件 hide()，等于「关闭按钮行为」这个设置形同虚设。
    // 现在要么真的退，要么按设置收进托盘。
    if (!loadConfig().closeToTray) return
    e.preventDefault()
    win.hide()
  })

  client = new DshClient(DSH_URL)
  store = new SessionStore(client)
  registerIpc(store)

  const push = (): void => {
    const snap = store?.snapshot() ?? null
    writeContextFile(snap, getState())
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('dsh:snapshot', snap)
  }
  store.onChange(push)
  push()

  // 感知状态变化 → 推给渲染进程（状态条 / 共享按钮要跟着变）
  onPerceptionChange(() => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('perception:changed', perceptionView())
    // 状态块里的感知摘要也一起刷新
    writeContextFile(store?.snapshot() ?? null, getState())
  })

  startControlServer({
    snapshot: () => store?.snapshot() ?? null,
    bubbleState: () => getState(),
    perception: () => ({ mode: getMode(), hint: getHint() }),
    command: async (cmd, args) => {
      switch (cmd) {
        case 'screenshot': {
          // 默认 foreground：只抓前台窗口 —— 最省 token，且拍不到气泡自己
          const mode = String(args.mode ?? 'foreground')
          if (mode === 'region') {
            const r = await selectRegion()
            if (!r) throw new Error('用户取消了框选')
            return r.image
          }
          if (mode === 'window') {
            return await captureWindow(String(args.title ?? ''))
          }
          return await captureDisplay(undefined, mode === 'screen' ? 'screen' : 'foreground')
        }
        case 'content_protection': {
          // Windows 原生能力 WDA_EXCLUDEFROMCAPTURE：
          // 窗口对**用户仍然可见**，但对截屏 API **不可见**。
          const on = args.on !== false
          getWindow()?.setContentProtection(on)
          return { on }
        }
        case 'set_monitor': {
          const m = String(args.mode ?? 'off') as MonitorMode
          if (m !== 'off' && m !== 'passive') throw new Error('mode 只能是 off / passive')
          setMonitorMode(m)
          return { mode: m, hint: getHint() }
        }
        case 'diary_search': {
          const q = String(args.query ?? '')
          const hits = searchDiary(q, Number(args.limit) || 6)
          return {
            entries: hits.map((e) => ({
              time: new Date(e.t).toLocaleTimeString(),
              kind: e.kind,
              text: e.text,
              hasThumb: Boolean(e.thumb),
              thumb: e.thumb ?? null,
            })),
          }
        }
        case 'visibility': {
          // 「让路」通道：自动化 / 模型需要看清屏幕时，把置顶气泡暂时收走。
          // 置顶是气泡的核心功能，不能为了这个去掉 —— 所以做成显式让路。
          const mode = String(args.mode ?? 'hide')
          const w = getWindow()
          if (!w) throw new Error('气泡窗口不存在')
          if (mode === 'hide') w.hide()
          else if (mode === 'show') showWindow()
          else if (mode === 'toggle') toggleVisible()
          else throw new Error('mode 只能是 hide / show / toggle')
          return { visible: w.isVisible(), mode }
        }
        case 'open_session': {
          const id = String(args.sessionId ?? '')
          if (!id) throw new Error('sessionId 必填')
          await store?.open(id)
          return { opened: id }
        }
        case 'resize': {
          const preset = String(args.preset ?? 'bubble') as FormFactor
          const s = setForm(preset)
          return { form: s.form, bounds: s.bounds }
        }
        default:
          throw new Error('未知指令: ' + cmd)
      }
    },
  })

  // 首次运行向导装完 dsh 后要能重连，否则用户会卡在「连不上 dsh」
  setRetryHook(() => connectDsh())

  // 全局快捷键（可在设置里自定义）
  registerAll({
    toggle: () => toggleVisible(),
    screenshot: () => { void stageScreen() },
    region: () => { void stageRegion() },
    paste: () => { void stageClipboard() },
    newSession: () => { void store?.createSession() },
  })

  createTray()

  await connectDsh()
}

/**
 * 连接 dsh 的完整流程：探活/拉起 → 接事件流 → 拉会话列表 → 打开最近会话。
 * 抽成函数是为了支持「重试」—— 首次运行向导刚帮用户装完 dsh 时，必须能重连一次，
 * 否则用户会卡在「连不上 dsh」上，而其实 dsh 已经装好了。
 */
async function connectDsh(): Promise<boolean> {
  if (!client || !store) return false
  const status = await ensureRunning(DSH_URL)
  store.setBus({
    state: status.state === 'ready' ? 'ready' : 'error',
    url: status.url,
    owned: status.owned,
    detail: status.detail,
  })
  if (status.state !== 'ready') {
    console.error('[boot] dsh 不可用：', status.detail)
    return false
  }

  client.connect()
  await store.syncList()
  const snap = store.snapshot()
  if (snap.current === null) {
    const first = snap.sessions.find((s) => !s.blank) ?? snap.sessions[0]
    if (first) await store.open(first.sessionId)
  }
  getWindow()?.webContents.send('dsh:snapshot', store.snapshot())
  writeContextFile(store.snapshot(), getState())
  return true
}

async function stageScreen(): Promise<void> {
  try { stageAttachments([await captureDisplay()]) } catch (err) { console.error('[hotkey] 截图失败', err) }
}

async function stageRegion(): Promise<void> {
  try {
    const r = await selectRegion()
    if (r) stageAttachments([r.image])
  } catch (err) { console.error('[hotkey] 框选失败', err) }
}

async function stageClipboard(): Promise<void> {
  try {
    const items = await attachmentsFromClipboard()
    if (items.length === 0) {
      showWindow()
      getWindow()?.webContents.send('attach:staged', [])
      return
    }
    stageAttachments(items)
  } catch (err) {
    console.error('[hotkey] 粘贴失败', err)
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('桌面气泡助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏气泡', click: () => toggleVisible() },
      { type: 'separator' },
      { label: '新建会话', click: () => void store?.createSession() },
      { label: '胶囊', click: () => setForm('capsule') },
      { label: '气泡', click: () => setForm('bubble') },
      { label: '面板', click: () => setForm('panel') },
      { type: 'separator' },
      { label: '刷新会话列表', click: () => void store?.syncList() },
      {
        label: '打开配置目录',
        click: () => void import('electron').then(({ shell }) => shell.openPath(app.getPath('userData'))),
      },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit() } },
    ]),
  )
  tray.on('click', () => toggleVisible())
}
