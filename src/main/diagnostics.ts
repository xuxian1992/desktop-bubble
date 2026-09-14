import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig } from './config'
import { probeRuntime, resolveDshInvocation } from './dsh-manager'
import { nodeRuntimeDir, findPortableNode } from './node-runtime'

/**
 * 一键诊断。
 *
 * 为什么需要它：这个项目要装到**别人的机器**上，而那边我看不见。
 * 之前靠一轮一轮问「把你看到的错误发我」—— 每轮只暴露一个问题，
 * 于是同一条链（Node → npm → dsh → 配置 → 端口）来回修了十轮。
 *
 * 一次把可能需要的东西全都取回来，一轮就能定位。
 */

/**
 * 跑一个命令并把它全部输出拿回来。
 *
 * ⚠️ `shell` 必须可传：dsh 在被解析成裸命令 `dsh` 时**只能靠 shell 找 PATH**。
 * 写死 `shell: false` 会让 `dsh --version` 直接 `spawn dsh ENOENT` ——
 * 而那份输出恰恰是整份诊断里最值钱的东西。
 */
function runCapture(cmd: string, args: string[], timeoutMs: number, shell = false): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const fin = (v: string): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell })
      const t = setTimeout(() => { try { c.kill() } catch { /* ignore */ }; fin(out + '\n[超时 ' + timeoutMs + 'ms]') }, timeoutMs)
      c.stdout.on('data', (d) => { out += String(d) })
      c.stderr.on('data', (d) => { out += String(d) })
      c.on('error', (e) => { clearTimeout(t); fin(out + '\n[无法启动: ' + e.message + ']') })
      c.on('exit', (code) => { clearTimeout(t); fin(out + '\n[退出码 ' + code + ']') })
    } catch (e) { fin('[异常: ' + String(e) + ']') }
  })
}

/** 读一个文本文件，附带 BOM / 换行 / 大小的诊断（BOM 曾经真的把 dsh 弄崩过） */
function readTextProbe(p: string): Record<string, unknown> {
  try {
    if (!existsSync(p)) return { path: p, exists: false }
    const bytes = readFileSync(p)
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const text = bytes.toString('utf8')
    return {
      path: p,
      exists: true,
      bytes: bytes.length,
      hasBom,
      crlf: (text.match(/\r\n/g) ?? []).length,
      loneLf: (text.match(/(?<!\r)\n/g) ?? []).length,
      content: text.slice(0, 4000),
    }
  } catch (e) {
    return { path: p, exists: true, error: String(e) }
  }
}

/** 端口被谁占着（Windows） */
async function portProbe(port: string): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') return { skipped: true }
  const cmd =
    '$c = Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;' +
    ' if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;' +
    ' [pscustomobject]@{ pid = $c.OwningProcess; name = $p.ProcessName; path = $p.Path } | ConvertTo-Json -Compress }'
  const out = await runCapture('powershell', ['-NoProfile', '-Command', cmd], 15000)
  return { raw: out.trim() }
}

export async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const home = homedir()
  const cfg = loadConfig()
  const runtime = await probeRuntime()

  // dsh 自己怎么说 —— 这是最有价值的一段
  const inv = await resolveDshInvocation()
  const version = await runCapture(inv.cmd, [...inv.args, '--version'], 25000, inv.shell)
  const dump = await runCapture(inv.cmd, [...inv.args, '--dump-config'], 25000, inv.shell)

  return {
    at: new Date().toISOString(),
    bubble: { version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData'), nodeRuntimeDir: nodeRuntimeDir(), portableNode: findPortableNode() },
    os: { platform: process.platform, release: process.getSystemVersion?.() ?? '', arch: process.arch, nodeInElectron: process.versions.node, electron: process.versions.electron },
    config: cfg,
    runtime,
    dshInvocation: { cmd: inv.cmd, args: inv.args, shell: inv.shell, pathHead: (inv.env.PATH ?? '').split(';').slice(0, 6) },
    dshVersion: version,
    dshDumpConfig: dump,
    files: {
      patch: readTextProbe(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')),
      agents: readTextProbe(join(home, '.dsh', 'AGENTS.md')),
    },
    port3080: await portProbe('3080'),
  }
}

export async function sendDiagnostics(url: string): Promise<{ ok: boolean; detail: string }> {
  const data = await collectDiagnostics()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
    return { ok: res.ok, detail: 'HTTP ' + res.status + '，已发送 ' + JSON.stringify(data).length + ' 字节' }
  } catch (e) {
    return { ok: false, detail: '发送失败：' + (e instanceof Error ? e.message : String(e)) }
  }
}
