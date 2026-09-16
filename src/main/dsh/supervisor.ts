import { spawn, type ChildProcess } from 'node:child_process'
import type { HostDescription } from '../../shared/dsh'
import { resolveDshInvocation } from '../dsh-manager'
import { acquireCookie, authHeaders, candidateStyles, extractToken, getCookie, getWebToken, setAuthStyle, setWebToken, withStyle, type AuthStyle } from './auth'

export type SupervisorState = 'idle' | 'probing' | 'spawning' | 'ready' | 'error'

export interface SupervisorStatus {
  state: SupervisorState
  url: string
  /** true = 我们自己拉起来的；false = 复用了已在跑的实例 */
  owned: boolean
  detail?: string
}

const DEFAULT_URL = 'http://127.0.0.1:3080'
const READY_TIMEOUT_MS = 40_000
const POLL_INTERVAL_MS = 700

let child: ChildProcess | null = null
/** dsh web 最近的输出 —— 起不来时全靠它说明原因 */
const outputTail: string[] = []

let sawOutput = false
const RING = 60

/**
 * 把 dsh web 的输出拼成可读的诊断文本。
 *
 * ⚠️ **头尾都要留**：错误消息在最前面，堆栈在最后面。
 * 之前只留最后 40 行 —— 结果最关键的那句「哪里错了」被挤掉了，
 * 用户发回来的日志只有代码片段和堆栈，谁都读不出来。
 */
function tailText(): string {
  if (outputTail.length === 0) return ''
  const head = outputTail.slice(0, 6)
  const tail = outputTail.slice(-26)
  const dropped = outputTail.length - head.length - tail.length
  const parts: string[] = ['', '— dsh web 的输出 —']
  parts.push(...head)
  if (dropped > 0) parts.push('… （省略 ' + dropped + ' 行）…')
  if (tail.length) parts.push(...tail)
  return '\n' + parts.join('\n')
}
let status: SupervisorStatus = { state: 'idle', url: DEFAULT_URL, owned: false }
const listeners = new Set<(s: SupervisorStatus) => void>()

function setStatus(next: Partial<SupervisorStatus>): void {
  status = { ...status, ...next }
  for (const l of listeners) l(status)
}

export function onStatus(cb: (s: SupervisorStatus) => void): () => void {
  listeners.add(cb)
  cb(status)
  return () => listeners.delete(cb)
}

export function getStatus(): SupervisorStatus {
  return status
}

/**
 * 一次 host.describe 探活。
 *
 * 有 token 时**依次试几种携带方式**，把能通的那种记进 auth 模块 ——
 * dsh 没文档说明这个 token 怎么带，而 0.1.5 才有的东西我本机复现不了，
 * 所以不猜，实测。定下来之后所有请求都用它。
 */
async function probe(base: string, timeoutMs = 1500): Promise<HostDescription | null> {
  // ★ 关键一步：dsh 0.1.5 的认证是 **Cookie**，而 token 只是「换 Cookie 的凭证」。
  //   直接拿 token 当查询参数挂到 /api/* 上是没用的（实测 401）。
  //   所以探活之前，先用 token 去 / 换一次 Cookie。
  if (getWebToken() && !getCookie()) {
    const ok = await acquireCookie(base)
    if (ok) console.log('[dsh] 已用 token 换到认证 Cookie')
  }

  for (const s of candidateStyles()) {
    const r = await probeOnce(base, timeoutMs, s)
    if (r) {
      if (getWebToken()) setAuthStyle(s)
      return r
    }
  }
  return null
}

async function probeOnce(base: string, timeoutMs: number, s: AuthStyle): Promise<HostDescription | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const req = withStyle(
      { url: base + '/api/host.describe', headers: { 'content-type': 'application/json' } as Record<string, string> },
      s,
    )
    // ⚠️ 必须把 authHeaders() 也带上 —— 它才是负责 **Cookie** 的那个。
    //    withStyle 只管 query/bearer/x-dsh-token/authorization 四种，
    //    而 dsh 0.1.5 用的恰恰是 Cookie —— 只调 withStyle 会让探活永远不带认证，
    //    于是「dsh 明明跑起来了却探测不到」，界面停在「未连接」。
    const headers = { ...req.headers, ...authHeaders() }
    const res = await fetch(req.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'host.describe', payload: {} }),
      signal: ac.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: { ok?: boolean; value?: HostDescription } }
    return json.result?.ok ? (json.result.value ?? null) : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function waitReady(base: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await probe(base, 2000)) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

/**
 * 确保 dsh web 在跑：先探活复用，不行才自己拉一个。
 * 复用时不持有子进程，退出也不杀它。
 */
/**
 * 确保 dsh 可用：探活 → 必要时拉起。
 *
 * `allowSpawn=false` 时**只探活、绝不启动进程** —— 这是 `autoLaunchDsh: false` 的语义：
 * 用户可能自己想管 dsh（甚至跑在另一台机器上），我们要能连上但不该越界去起进程。
 */
export async function ensureRunning(base = DEFAULT_URL, allowSpawn = true): Promise<SupervisorStatus> {
  setStatus({ url: base, state: 'probing', detail: undefined })

  const port = new URL(base).port || '3080'

  // ① 已经在跑 → 直接复用
  if (await probe(base)) {
    setStatus({ state: 'ready', owned: false, detail: '复用已在运行的 dsh web' })
    return status
  }

  // ② 端口被占、但探活不通 —— 多半是**上一次的启动还在路上**。
  //    用户点了几次「启动 dsh」时最容易撞上这个：每次都 spawn 一个新的，
  //    第一个还在启动，第二个就 EADDRINUSE 死掉，看起来像「怎么点都起不来」。
  const owner = await portOwner(port)
  if (owner) {
    setStatus({
      state: 'probing',
      detail: '端口 ' + port + ' 已被占用（PID ' + owner.pid + (owner.name ? ' ' + owner.name : '') + '），等它就绪…',
    })
    if (await waitReady(base, Date.now() + 20000)) {
      setStatus({ state: 'ready', owned: false, detail: '复用已在运行的 dsh web' })
      return status
    }
    // 等了 20 秒还是不通。如果占端口的是 node/dsh，说明那是我们自己的僵尸进程，清掉；
    // 是别的东西就绝不动它 —— 让下面的 spawn 去报 EADDRINUSE，把真相告诉用户。
    if (/node|dsh/i.test(owner.name)) {
      setStatus({ state: 'spawning', detail: '占用端口的 ' + owner.name + '（PID ' + owner.pid + '）没响应，结束它后重来' })
      try { process.kill(owner.pid) } catch { /* 权限不够就算了 */ }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  // 走到这里说明探活失败。如果调用方不允许我们拉起进程，就到此为止 ——
  // 把「探了但没有」如实报回去，而不是偷偷起一个。
  if (!allowSpawn) {
    setStatus({ state: 'error', detail: 'dsh 没在跑，而「开机自动启动 dsh」是关着的 —— 请自行启动，或打开那个开关' })
    return status
  }

  // ⚠️ 关键是**环境和调用方式**，不只是命令本身：
  //   · 便携版 node 不在系统 PATH 上 → dsh 起的子进程找不到 node → 装上了也连不上
  //   · 路径含空格时不能裸传（cmd.exe 会在空格处断开）
  // resolveDshInvocation 一次把这些都处理掉。
  outputTail.length = 0
  const inv = await resolveDshInvocation()
  setStatus({ state: 'spawning', detail: '正在启动 dsh web …\n' + inv.cmd + ' ' + inv.args.join(' ') })
  try {
    // ⚠️ 以前这里是 stdio: 'ignore' —— 等于把唯一能说明「为什么起不来」的东西丢掉了。
    // 起不来时界面上只有一句干巴巴的「连不上 dsh」，谁都查不下去。
    // 现在把它的输出留着（环形缓冲最后若干行），失败时连同 detail 一起给出去。
    child = spawn(inv.cmd, [...inv.args, 'web', '--host', '127.0.0.1', '--port', port, '--no-open'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: inv.shell,
      env: inv.env,
    })
    const pushTail = (d: unknown): void => {
      for (const line of String(d).split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        outputTail.push(t)
        if (outputTail.length > RING) outputTail.shift()
        // 新版 dsh 启动会打印 `.../?token=XXX` —— 抓到它，后面所有请求都要带
        const tok = extractToken(t)
        if (tok) setWebToken(tok)
      }
    }
    child.stdout?.on('data', pushTail)
    child.stderr?.on('data', pushTail)
    child.on('exit', (code) => {
      child = null
      if (status.state === 'ready' && status.owned) {
        setStatus({ state: 'error', detail: 'dsh web 进程退出了（code ' + code + '）' + tailText() })
      }
    })
  } catch (err) {
    setStatus({ state: 'error', detail: '无法启动 dsh web：' + String(err) })
    return status
  }

  const ok = await waitReady(base, Date.now() + READY_TIMEOUT_MS)
  if (ok) {
    setStatus({ state: 'ready', owned: true, detail: '已拉起 dsh web' })
  } else {
    setStatus({ state: 'error', detail: 'dsh web 启动超时（40s）' + tailText() })
  }
  return status
}

interface PortOwner { pid: number; name: string }

/**
 * 谁占着这个端口？
 *
 * 为什么需要：用户点了几次「启动 dsh」，每次都探活失败 → 每次都 spawn 一个新的，
 * 而 dsh 启动不快 —— 第一个还在启动，第二个就撞 `EADDRINUSE` 死掉，
 * 表现得就像「怎么点都起不来」。
 */
async function portOwner(port: string): Promise<PortOwner | null> {
  const ps = process.platform === 'win32' ? 'powershell' : 'sh'
  const cmd =
    process.platform === 'win32'
      ? '$p = Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; "$p|$n" }'
      : 'lsof -ti tcp:' + port + ' 2>/dev/null | head -1'
  const out = await tryRun(ps, ['-NoProfile', '-Command', cmd], 12000)
  if (!out) return null
  const line = out.trim().split(/\r?\n/).pop() ?? ''
  if (process.platform === 'win32') {
    const [pidStr, name] = line.split('|')
    const pid = Number(pidStr)
    return Number.isFinite(pid) && pid > 0 ? { pid, name: name ?? '' } : null
  }
  const pid = Number(line)
  return Number.isFinite(pid) && pid > 0 ? { pid, name: '' } : null
}

function tryRun(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const fin = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      const t = setTimeout(() => { try { c.kill() } catch { /* ignore */ }; fin(null) }, timeoutMs)
      c.stdout?.on('data', (d) => { out += String(d) })
      c.on('error', () => { clearTimeout(t); fin(null) })
      c.on('exit', (code) => { clearTimeout(t); fin(code === 0 ? out : null) })
    } catch { fin(null) }
  })
}

/** 只停我们自己拉起来的实例 */
export function stopOwned(): void {
  if (child && status.owned) {
    try { child.kill() } catch { /* ignore */ }
    child = null
  }
}
