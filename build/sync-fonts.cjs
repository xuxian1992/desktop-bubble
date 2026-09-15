/**
 * 同步 VCP 内置字体到 renderer 的 public 目录。
 *
 *   node build/sync-fonts.cjs              # 从本机已装的 dsh-raw-html 插件目录拷
 *   node build/sync-fonts.cjs --from-url   # 从插件仓库下载（CI 用）
 *   node build/sync-fonts.cjs --src <dir>  # 指定字体目录
 *
 * 为什么这么做：这 26 款 woff2 是二进制、且本来就是 dsh-raw-html 插件分发的东西，
 * 没必要在版本库里再存一份（54MB）。字体放在 public/fonts/，构建时原样拷进
 * out/renderer/fonts/，运行时由 src/vcpFonts.ts 注册 @font-face。
 *
 * **缺字体不是错误**：拿不到就跳过，浏览器回退系统字体，构建照常成功。
 * 所以这个脚本永远以 0 退出，只在日志里说明结果。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const REPO = 'plolpl789/dsh-raw-html'
const DEST = path.join(__dirname, '..', 'src', 'renderer', 'public', 'fonts')

function log(msg) {
  console.log('[sync-fonts] ' + msg)
}

/** 默认来源：本机 dsh 的插件目录（装了插件就有）。 */
function defaultSource() {
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'plugins', 'dsh-raw-html', 'assets', 'fonts')
}

function readArg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 本机目录 → 复制。 */
function copyFromDir(src) {
  if (!fs.existsSync(src)) return { ok: false, reason: '目录不存在：' + src }
  const files = fs.readdirSync(src).filter((f) => f.toLowerCase().endsWith('.woff2'))
  if (files.length === 0) return { ok: false, reason: '目录里没有 woff2：' + src }
  ensureDir(DEST)
  let copied = 0
  let skipped = 0
  for (const f of files) {
    const from = path.join(src, f)
    const to = path.join(DEST, f)
    const a = fs.statSync(from)
    if (fs.existsSync(to) && fs.statSync(to).size === a.size) {
      skipped++
      continue
    }
    fs.copyFileSync(from, to)
    copied++
  }
  return { ok: true, detail: '来源 ' + src + '：新拷 ' + copied + ' 个，已是最新 ' + skipped + ' 个' }
}

/** 插件仓库 → 下载。 */
async function fetchFromUrl() {
  const api = 'https://api.github.com/repos/' + REPO + '/contents/assets/fonts'
  let list
  try {
    const res = await fetch(api, { headers: { 'user-agent': 'desktop-bubble', accept: 'application/vnd.github+json' } })
    if (!res.ok) return { ok: false, reason: '列目录失败 HTTP ' + res.status }
    list = await res.json()
  } catch (err) {
    return { ok: false, reason: '列目录异常：' + String(err && err.message) }
  }
  const items = (Array.isArray(list) ? list : []).filter((x) => x.name && x.name.toLowerCase().endsWith('.woff2'))
  if (items.length === 0) return { ok: false, reason: '仓库里没有 woff2' }
  ensureDir(DEST)
  let got = 0
  let skipped = 0
  for (const item of items) {
    const to = path.join(DEST, item.name)
    if (fs.existsSync(to) && fs.statSync(to).size === item.size) {
      skipped++
      continue
    }
    try {
      const res = await fetch(item.download_url, { headers: { 'user-agent': 'desktop-bubble' } })
      if (!res.ok) continue
      fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()))
      got++
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return { ok: true, detail: '来自插件仓库：新下 ' + got + ' 个，已是最新 ' + skipped + ' 个' }
}

async function main() {
  const src = readArg('--src')
  const fromUrl = process.argv.includes('--from-url')

  let result
  if (src) result = copyFromDir(src)
  else if (fromUrl) result = await fetchFromUrl()
  else {
    result = copyFromDir(defaultSource())
    if (!result.ok) {
      log('本机没找到插件字体（' + result.reason + '）。')
      log('装了 dsh-raw-html 插件就能直接拷；也可以 --from-url 从插件仓库下载。')
      log('跳过 —— 气泡照常构建，卡片会用系统字体兜底。')
      return
    }
  }

  if (!result.ok) {
    log('没同步到字体：' + result.reason)
    log('跳过 —— 气泡照常构建，卡片会用系统字体兜底。')
    return
  }
  const n = fs.readdirSync(DEST).filter((f) => f.toLowerCase().endsWith('.woff2')).length
  log(result.detail)
  log('public/fonts 现有 ' + n + ' 款字体。')
}

main().catch((err) => {
  log('同步出错（已忽略）：' + String(err && err.message))
})
