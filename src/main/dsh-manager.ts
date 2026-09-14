import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findPortableDsh, findPortableNode, npmCliJs } from './node-runtime'

/** dsh 运行时管理：检测 / 引导安装。安装包不内置 dsh（方案 D3 决策）。 */

export interface DshProbe {
  found: boolean
  version?: string
  command?: string
  source: 'path' | 'global-npm' | 'portable' | 'none'
}

function tryRun(cmd: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ }; finish(null) }, timeoutMs)
      child.stdout?.on('data', (d) => { out += String(d) })
      child.stderr?.on('data', (d) => { out += String(d) })
      child.on('error', () => { clearTimeout(timer); finish(null) })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0 ? out : null)
      })
    } catch {
      finish(null)
    }
  })
}

/**
 * 检测 dsh。**顺序即优先级 —— 用户自己装的一律先用，绝不越俎代庖。**
 *
 *   ① PATH 上的 dsh          （用户自己装的，最优先）
 *   ② 用户 npm 的全局目录     （用户自己 npm -g 装的）
 *   ③ 我们便携 node 的目录    （只有前两条都没有才轮到它）
 */
export async function probeDsh(): Promise<DshProbe> {
  const viaPath = await tryRun('dsh', ['--version'], 12000)
  if (viaPath !== null) {
    return { found: true, version: viaPath.trim().split(/\s+/).pop(), command: 'dsh', source: 'path' }
  }
  const prefix = await tryRun('npm', ['prefix', '-g'], 15000)
  if (prefix) {
    const guess = join(prefix.trim(), 'dsh.cmd')
    if (existsSync(guess)) return { found: true, command: guess, source: 'global-npm' }
  }
  // 都没有 → 看看我们上次帮装的便携版里有没有
  const ours = findPortableDsh()
  if (ours) return { found: true, command: ours, source: 'portable' }
  return { found: false, source: 'none' }
}

/**
 * 找出真正的 node 可执行文件。
 *
 * ⚠️ 不能用 process.execPath —— 打包后那是**应用自己的 exe**，不是 node。
 * 拿它当 MCP 服务端的 command，dsh 会去「用 Electron 跑一个 .mjs」，必然失败。
 * 优先探测真实路径，探不到就退回裸命令 'node'（由 PATH 解析）。
 */
export async function resolveNodeExe(): Promise<string> {
  // 系统里已有 Node → 用系统的（尊重用户环境，也不让 MCP 依赖我们的目录）
  const out = await tryRun(process.platform === 'win32' ? 'where' : 'which', ['node'], 12000)
  if (out) {
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first) return first
  }
  // 系统没有 → 用我们帮装的便携版（MCP 配置本来就需要 node.exe 的绝对路径）
  const portable = findPortableNode()
  if (portable) return portable
  return 'node'
}

export interface NpmProbe { found: boolean; version?: string; source?: 'path' | 'portable' }

/** 装 dsh 要靠 npm —— 新机器上很可能是没有的，得单独探一下给出人话提示 */
export async function probeNpm(): Promise<NpmProbe> {
  const v = await tryRun('npm', ['--version'], 15000)
  if (v !== null) return { found: true, version: v.trim().split(/\s+/).pop(), source: 'path' }
  // 系统没有 → 认我们帮装的便携版
  const node = findPortableNode()
  if (node) {
    const pv = await tryRun(node, [npmCliJs(node), '--version'], 20000)
    if (pv !== null) return { found: true, version: pv.trim().split(/\s+/).pop(), source: 'portable' }
  }
  return { found: false }
}

export interface RuntimeStatus {
  node: { found: boolean; version?: string; portable: boolean }
  npm: { found: boolean; version?: string; portable: boolean }
  dsh: DshProbe
  /** 便携版是否已下载到本机 */
  portableInstalled: boolean
}

/**
 * 一次性把三样东西探清楚。
 *
 * 向导靠它决定「给用户看哪个按钮」—— 原则是**先校验、再安装**：
 * 机器上已经有的东西一律只用不装。
 */
export async function probeRuntime(): Promise<RuntimeStatus> {
  const sysNode = await tryRun(process.platform === 'win32' ? 'where' : 'which', ['node'], 12000)
  const portable = findPortableNode()
  const sysNodePath = sysNode ? sysNode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] : undefined
  const nodeVer = sysNodePath
    ? (await tryRun(sysNodePath, ['-v'], 12000))?.trim()
    : (portable ? (await tryRun(portable, ['-v'], 12000))?.trim() : undefined)
  const npmProbe = await probeNpm()
  return {
    node: {
      found: Boolean(sysNodePath) || Boolean(portable),
      version: nodeVer || undefined,
      portable: !sysNodePath && Boolean(portable),
    },
    npm: { found: npmProbe.found, version: npmProbe.version, portable: npmProbe.source === 'portable' },
    dsh: await probeDsh(),
    portableInstalled: Boolean(portable),
  }
}

let installing: ChildProcess | null = null

/**
 * 帮用户装 dsh。输出实时回传给渲染进程，让用户看到进度而不是干等。
 *
 * **先校验、再安装**：机器上已经有 npm 就用它的，绝不重复装 Node。
 * 只有系统里没有 npm 时，才退回我们帮装的便携版 Node.js。
 */
export function installDsh(onLine: (line: string) => void, onDone: (ok: boolean, detail: string) => void): void {
  if (installing) {
    onDone(false, '已经有一个安装任务在进行中')
    return
  }
  void (async () => {
    // ① 先看系统的 npm（真实探测，不靠 PATH 字符串猜）
    const sys = await probeNpm()
    let cmd: string
    let args: string[]
    let useShell: boolean

    if (sys.found && sys.source !== 'portable') {
      onLine('使用系统 npm' + (sys.version ? ' v' + sys.version : ''))
      cmd = 'npm'
      args = ['install', '-g', '@deepseek-ai/dsh']
      useShell = true
    } else {
      // ② 系统没有 → 用便携 node 跑 npm-cli.js
      //
      // ⚠️ 便携这条**不能** spawn npm.cmd：Node 20+ 出于安全直接拒绝（实测 spawn EINVAL）。
      //    改成 node.exe + npm-cli.js 后既绕开 .cmd，也不经过 shell，没有转义问题。
      const node = findPortableNode()
      if (!node) {
        onDone(false, '系统里没有 npm，也没有便携版 Node.js —— 请先安装 Node.js')
        return
      }
      onLine('使用便携版 Node.js：' + node)
      cmd = node
      args = [npmCliJs(node), 'install', '-g', '@deepseek-ai/dsh']
      useShell = false
    }

    try {
      installing = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      })
    } catch (err) {
      onDone(false, err instanceof Error ? err.message : String(err))
      return
    }

    const push = (d: unknown): void => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) onLine(line)
    }
    installing.stdout?.on('data', push)
    installing.stderr?.on('data', push)
    installing.on('error', (err) => { installing = null; onDone(false, err.message) })
    installing.on('exit', (code) => {
      installing = null
      onDone(code === 0, code === 0 ? '安装完成' : '安装失败（退出码 ' + code + '）')
    })
  })()
}