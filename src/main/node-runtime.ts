import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

/**
 * 便携版 Node.js 运行时。
 *
 * 为什么需要：向导原来只能「引导用户去 nodejs.org 自己下载」——
 * 而 Node.js 是整条链的第一环（Node → npm → dsh），它断了后面全断。
 * 用户在笔记本上看到的就是「它只检测，什么都不帮我装」。
 *
 * 为什么用便携版 zip 而不是 MSI：
 *   · **不需要管理员权限**（MSI 要）
 *   · **不动系统 PATH**，不污染用户的机器
 *   · 卸载时删目录即可，干净
 *   · 而且 MCP 配置**本来就需要 node.exe 的绝对路径** —— 现成的
 *
 * 便携版解压在 %APPDATA%/desktop-bubble/node/ 下，与用户自己装的 Node 互不干扰。
 * 如果用户机器上已经有 Node/npm，**一律优先用他已有的**，绝不重复安装。
 */

/** 默认版本。npmmirror 上有完整镜像，实测可下（约 34 MB）。 */
const NODE_VERSION = 'v22.20.0'
const MIRRORS = [
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist',
]

export function nodeRuntimeDir(): string {
  return join(app.getPath('userData'), 'node')
}

/** 在便携目录里递归找 node.exe（解压出来是 node-vX-win-x64/node.exe，不写死路径以便换版本） */
export function findPortableNode(): string | null {
  const root = nodeRuntimeDir()
  if (!existsSync(root)) return null
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return null }
    for (const e of entries) {
      const p = join(dir, e)
      try {
        const st = statSync(p)
        if (st.isFile() && e.toLowerCase() === 'node.exe') return p
        if (st.isDirectory()) {
          const hit = walk(p, depth + 1)
          if (hit) return hit
        }
      } catch { /* 跳过读不了的 */ }
    }
    return null
  }
  return walk(root, 0)
}

/** 便携目录里是否有装着 dsh 的全局安装（npm -g 会把 dsh.cmd 放在 node 同级） */
export function findPortableDsh(): string | null {
  const node = findPortableNode()
  if (!node) return null
  const guess = join(node, '..', 'dsh.cmd')
  return existsSync(guess) ? guess : null
}

/**
 * 便携 node 的 npm 入口（JS 文件）。
 *
 * ⚠️ 不要 spawn `npm.cmd`：Node 20+ 出于安全直接拒绝（实测 spawn EINVAL）。
 * 正确做法是用 node.exe 跑 npm-cli.js —— 既不碰 .cmd，也不经过 shell，没有转义问题。
 */
export function npmCliJs(nodeExe: string): string {
  return join(nodeExe, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

export function removePortableNode(): { ok: boolean; detail: string } {
  try {
    rmSync(nodeRuntimeDir(), { recursive: true, force: true })
    return { ok: true, detail: '已删除便携版 Node.js' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', shell: false })
      const t = setTimeout(() => { try { c.kill() } catch { /* ignore */ }; finish(false) }, timeoutMs)
      c.on('error', () => { clearTimeout(t); finish(false) })
      c.on('exit', (code) => { clearTimeout(t); finish(code === 0) })
    } catch { finish(false) }
  })
}

export interface NodeInstallResult { ok: boolean; detail: string; nodeExe?: string }

/**
 * 下载并解压便携版 Node.js。
 * onLine 把进度实时回传渲染进程 —— 34MB 下载要几十秒，不能让用户干等。
 */
export async function installPortableNode(
  onLine: (line: string) => void,
): Promise<NodeInstallResult> {
  const dir = nodeRuntimeDir()
  const zip = join(app.getPath('temp'), 'desktop-bubble-node.zip')

  // 已经装过就直接复用（幂等）
  const existing = findPortableNode()
  if (existing) return { ok: true, detail: '已存在便携版 Node.js，直接复用', nodeExe: existing }

  mkdirSync(dir, { recursive: true })

  let lastErr = ''
  for (const base of MIRRORS) {
    const url = base + '/' + NODE_VERSION + '/node-' + NODE_VERSION + '-win-x64.zip'
    try {
      onLine('正在下载 ' + url)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) { lastErr = 'HTTP ' + res.status; onLine('  失败：' + lastErr); continue }
      const total = Number(res.headers.get('content-length') || 0)
      let got = 0
      let nextReport = 0
      const counter = new TransformStream({
        transform(chunk, controller) {
          got += chunk.byteLength
          if (total > 0 && got >= nextReport) {
            nextReport = got + total / 20
            onLine('  已下载 ' + Math.round((got / total) * 100) + '%（' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB）')
          }
          controller.enqueue(chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(zip))
      onLine('下载完成，正在解压…')

      // Windows 10+ 自带 bsdtar，解 zip 比 PowerShell 的 Expand-Archive 快得多
      let ok = await run('tar', ['-xf', zip, '-C', dir], 300000)
      if (!ok) {
        onLine('  tar 解压失败，改用 PowerShell…')
        ok = await run('powershell', ['-NoProfile', '-Command',
          'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(dir) + ' -Force'],
          600000)
      }
      if (!ok) { lastErr = '解压失败'; onLine('  解压失败'); continue }

      const nodeExe = findPortableNode()
      if (!nodeExe) { lastErr = '解压后没找到 node.exe'; onLine('  ' + lastErr); continue }

      try { rmSync(zip, { force: true }) } catch { /* 临时文件删不掉无所谓 */ }
      onLine('完成：' + nodeExe)
      return { ok: true, detail: '便携版 Node.js 已就绪', nodeExe }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      onLine('  失败：' + lastErr)
    }
  }
  return { ok: false, detail: '下载或解压失败：' + lastErr }
}
