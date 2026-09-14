import { spawn, type ChildProcess } from 'node:child_process'
import type { HostDescription } from '../../shared/dsh'
import { resolveDshInvocation } from '../dsh-manager'

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

/** 把 dsh web 的最后几行拼成可读的诊断文本（没有就返回空串） */
function tailText(): string {
  if (outputTail.length === 0) return ''
  return '\n\n— dsh web 最后的输出 —\n' + outputTail.slice(-12).join('\n')
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

/** 一次 host.describe 探活：能拿到 value 就说明 /api 可用且信任栅栏放行 */
async function probe(base: string, timeoutMs = 1500): Promise<HostDescription | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(base + '/api/host.describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
export async function ensureRunning(base = DEFAULT_URL): Promise<SupervisorStatus> {
  setStatus({ url: base, state: 'probing', detail: undefined })

  if (await probe(base)) {
    setStatus({ state: 'ready', owned: false, detail: '复用已在运行的 dsh web' })
    return status
  }

  const port = new URL(base).port || '3080'
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
        if (outputTail.length > 40) outputTail.shift()
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

/** 只停我们自己拉起来的实例 */
export function stopOwned(): void {
  if (child && status.owned) {
    try { child.kill() } catch { /* ignore */ }
    child = null
  }
}
