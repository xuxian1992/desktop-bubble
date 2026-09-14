import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/**
 * 找系统里的 node.exe —— **不只靠 PATH**。
 *
 * 为什么要这么麻烦：Node.js 装完之后，**已经在跑的进程不会自动看到新 PATH**。
 * 而气泡可能是从 VBS 启动的，继承的是 explorer 的环境 —— 用户刚装完 Node，
 * 应用眼里却「没有 npm」，于是「点了我装」但命令根本找不到。
 * 所以这里多探几个常见安装位置，拿到绝对路径绕开 PATH。
 */
/**
 * 从**注册表**读真实的 PATH。
 *
 * 为什么不能只信 `process.env.PATH`：它是进程启动时那一份快照。
 * 用户刚装完 Node、或者气泡是从很旧的快捷方式/explorer 环境拉起来的，
 * 进程里的 PATH 就可能是陈旧的 —— 明明装了 Node，应用却「看不见」。
 * 注册表里那份才是当前值。
 */
async function registryPathDirs(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ]
  const dirs: string[] = []
  for (const k of keys) {
    // ⚠️ 机器级那个 key 含空格（Session Manager）—— tryRun 走 shell，不加引号会在空格处断开
    const keyArg = /\s/.test(k) ? '"' + k + '"' : k
    const out = await tryRun('reg', ['query', keyArg, '/v', 'Path'], 8000)
    if (!out) continue
    // 形如：    Path    REG_EXPAND_SZ    C:\a;C:\b
    const m = out.match(/Path\s+REG_[A-Z_]*(?:SZ)?\s+(.+)/i)
    if (!m) continue
    for (const seg of m[1].split(';')) {
      const s = seg.trim().replace(/^"|"$/g, '')
      if (!s) continue
      // 展开 %VAR%
      const expanded = s.replace(/%([^%]+)%/g, (_all, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? '')
      if (expanded) dirs.push(expanded)
    }
  }
  return dirs
}

/**
 * 找系统里的 node.exe。四路探测，从便宜到昂贵：
 *   ① PATH（最快）
 *   ② 常见安装位置（官方安装器、Program Files）
 *   ③ **注册表里的 PATH** —— 解决「刚装完 Node，进程看不到」
 *   ④ 版本管理器（nvm / fnm / volta / scoop / chocolatey）
 */
async function resolveSystemNode(): Promise<string | null> {
  const probe = (p: string): string | null => {
    try { return p && existsSync(p) ? p : null } catch { return null }
  }

  // ① PATH
  const out = await tryRun(process.platform === 'win32' ? 'where' : 'which', ['node'], 12000)
  if (out) {
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    const hit = first ? probe(first) : null
    if (hit) return hit
  }

  if (process.platform !== 'win32') {
    for (const p of ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']) {
      const hit = probe(p); if (hit) return hit
    }
    return null
  }

  // ② 常见安装位置
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  const home = process.env.USERPROFILE ?? ''
  for (const p of [
    join(pf, 'nodejs', 'node.exe'),
    join(pf86, 'nodejs', 'node.exe'),
    join(local, 'Programs', 'nodejs', 'node.exe'),
    join('C:\\Program Files', 'nodejs', 'node.exe'),
    // ④ 版本管理器
    join(roaming, 'nvm', 'current', 'node.exe'),
    join(local, 'Volta', 'bin', 'node.exe'),
    join(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'),
    join(home, 'scoop', 'shims', 'node.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\node.exe',
  ]) {
    const hit = probe(p); if (hit) return hit
  }

  // ③ 注册表 PATH 里的目录
  for (const d of await registryPathDirs()) {
    const hit = probe(join(d, 'node.exe'))
    if (hit) return hit
  }

  return null
}

export interface NpmInvocation { cmd: string; args: string[]; shell: boolean; label: string }

/**
 * 决定「怎么调 npm」。
 *
 * 优先用 `node.exe + npm-cli.js` 的绝对路径形式：
 *   · 不依赖 PATH（解决刚装完 Node 的进程看不到 npm）
 *   · 不经过 shell（没有引号转义问题，也没有 .cmd 的 spawn EINVAL）
 * 实在找不到 node 才退回裸 `npm`。
 */
export async function resolveNpmInvocation(): Promise<NpmInvocation> {
  const portable = findPortableNode()
  if (portable) {
    const cli = npmCliJs(portable)
    if (existsSync(cli)) return { cmd: portable, args: [cli], shell: false, label: '便携版 npm' }
  }
  const sys = await resolveSystemNode()
  if (sys) {
    const cli = npmCliJs(sys)
    if (existsSync(cli)) return { cmd: sys, args: [cli], shell: false, label: '系统 npm（绝对路径）' }
  }
  return { cmd: 'npm', args: [], shell: true, label: 'PATH 上的 npm' }
}

export interface NpmProbe { found: boolean; version?: string; source?: 'path' | 'portable' }

/** 装 dsh 要靠 npm —— 新机器上很可能是没有的，得单独探一下给出人话提示 */
export async function probeNpm(): Promise<NpmProbe> {
  // 先用绝对路径形式探（不依赖 PATH）
  const inv = await resolveNpmInvocation()
  const v = await tryRun(inv.cmd, [...inv.args, '--version'], 20000)
  if (v !== null) {
    const ver = v.trim().split(/\s+/).pop()
    if (inv.label.includes('便携')) return { found: true, version: ver, source: 'portable' }
    return { found: true, version: ver, source: 'path' }
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

    // 统一走「解析出的 npm 调用方式」：
    //   node.exe + npm-cli.js 的绝对路径形式，不依赖 PATH、不经过 shell。
    //
    // ⚠️ 两条都不能用：
    //   · spawn('npm', …, {shell:true}) —— 依赖 PATH，刚装完 Node 的进程可能看不到 npm
    //   · spawn('npm.cmd', …) 不带 shell —— Node 20+ 直接拒绝（实测 spawn EINVAL）
    const inv = await resolveNpmInvocation()
    onLine('使用 ' + inv.label + (sys.version ? ' v' + sys.version : ''))
    onLine('  命令: ' + inv.cmd + ' ' + inv.args.join(' '))
    cmd = inv.cmd
    args = [...inv.args, 'install', '-g', '@deepseek-ai/dsh']
    useShell = inv.shell

    // ⚠️ 便携版 node 不在系统 PATH 上（我们刻意不改用户的机器）。
    // 但 npm 的**构建脚本**是另起一个 cmd.exe 跑的，继承的是系统 PATH ——
    // 于是 koffi 这种原生模块的 `cmd /d /s /c node ./cnoke.cjs …` 就找不到 node，
    // 报「'node' 不是内部或外部命令」，整包装不下。
    //
    // 解法：只把便携版 node 的目录塞进**这个子进程**的 PATH。
    // 系统的 PATH 一个字都不动 —— 影响范围仅限这一次安装。
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (!useShell) {
      const nodeDir = dirname(cmd)
      env.PATH = nodeDir + ';' + (env.PATH ?? '')
      onLine('  已把 ' + nodeDir + ' 加入本次安装的 PATH（便于原生模块编译）')

      // 上一次失败的安装会留下残缺目录（npm 自己会报 EPERM 清理不掉，尤其是被占用时）。
      // 不清掉的话重装会在半成品上叠加，更容易再失败。这里尽力清一次，清不掉也不拦着往下走。
      const partial = join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh')
      if (existsSync(partial)) {
        onLine('  检测到上次安装的残留，先清理…')
        try {
          rmSync(partial, { recursive: true, force: true })
          onLine('  已清理')
        } catch (err) {
          onLine('  清理失败（多半是被占用）：' + (err instanceof Error ? err.message : String(err)))
          onLine('  会继续尝试安装')
        }
      }
    }
    env.npm_config_audit = 'false'
    env.npm_config_fund = 'false'

    try {
      installing = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        env,
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