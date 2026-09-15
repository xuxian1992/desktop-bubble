/**
 * dsh web 的访问 token。
 *
 * 新版 dsh（0.1.5+）给 web 加了访问控制 —— 启动时会打印：
 *
 *   dsh web: http://127.0.0.1:3080/?token=t_ksqoT85QElGXneeEwH39wRv6lTR98vhn1tIp4TFjw
 *
 * 气泡原来不带它去探活，于是**被拒 → 探测失败 → 判定「启动超时」**，
 * 而 dsh 其实起得好好的。这就是「装上了、在跑、却连不上」的真因。
 *
 * 这里不写死是哪一种携带方式（dsh 没文档，我也没法在本机复现 0.1.5），
 * 而是**依次试几种，记下能通的那种**，之后所有请求都用它。
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AuthStyle = 'none' | 'cookie' | 'query' | 'bearer' | 'x-dsh-token' | 'authorization'

let token: string | null = null
let style: AuthStyle = 'none'
/**
 * 认证 Cookie。
 *
 * ★ 这是 dsh 0.1.5 的真实机制（Hermes 在那台机器上实测出来的）：
 *
 *   GET /?token=XXX   →  303 See Other，location: /
 *                       同时响应头 set-cookie: dsh-auth-<实例id>=v1.<签名>
 *
 * **`?token=` 只是「换 Cookie 的凭证」，本身不是认证。**
 * 我一开始把 token 当查询参数往 /api/* 上挂 —— 结果一直是 401，卡了好几轮。
 */
let cookie: string | null = null

export function getCookie(): string | null { return cookie }

/** 用 token 去换 Cookie（303 + Set-Cookie）。成功返回 true。 */
export async function acquireCookie(base: string): Promise<boolean> {
  if (!token) return false
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/?token=' + encodeURIComponent(token), {
      redirect: 'manual', // 303 就是我们要的，别跟过去
    })
    const sc = res.headers.get('set-cookie')
    if (!sc) return false
    // 只要 name=value，属性（Path/HttpOnly/...）不用带
    cookie = sc.split(';')[0].trim()
    style = 'cookie'
    return true
  } catch {
    return false
  }
}

export function setWebToken(t: string | null): void {
  if (t === token) return
  token = t
  style = t ? 'query' : 'none' // 先按最可能的猜，探活会纠正
  persist()
}

/**
 * token 落到磁盘。
 *
 * 为什么：token 只在 **`dsh web` 自己启动时**打印一次。
 * 如果气泡下次是「复用已在跑的实例」，它就永远看不到那个 token 了 ——
 * 于是又变成连不上。存一份，下次直接读。
 */
function tokenFile(): string {
  try {
    // 延迟 require：这个模块也可能在渲染层之外被引用
    const { app } = require('electron') as typeof import('electron')
    return join(app.getPath('userData'), 'dsh-token.txt')
  } catch {
    return ''
  }
}

function persist(): void {
  const p = tokenFile()
  if (!p) return
  try {
    if (token) writeFileSync(p, token, 'utf8')
    else rmSync(p, { force: true })
  } catch { /* 存不下就算了，不影响本次运行 */ }
}

/** 启动时读回上次的 token */
export function loadPersistedToken(): void {
  const p = tokenFile()
  if (!p) return
  try {
    const t = readFileSync(p, 'utf8').trim()
    if (t) setWebToken(t)
  } catch { /* 没有就算了 */ }
}

export function getWebToken(): string | null { return token }
export function getAuthStyle(): AuthStyle { return style }
export function setAuthStyle(s: AuthStyle): void { style = s }

/** 从 dsh web 的一行输出里抓 token（抓不到返回 null） */
export function extractToken(line: string): string | null {
  const m = /token=([A-Za-z0-9_-]{8,})/.exec(line)
  return m ? m[1] : null
}

/** 给 URL 加认证（query 形式时） */
export function withAuth(url: string): string {
  if (!token || style !== 'query') return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

/** 给请求加认证头（头形式时） */
export function authHeaders(): Record<string, string> {
  if (cookie) return { cookie }
  if (!token) return {}
  if (style === 'bearer') return { authorization: 'Bearer ' + token }
  if (style === 'x-dsh-token') return { 'x-dsh-token': token }
  if (style === 'authorization') return { authorization: token }
  return {}
}

/** 探活时依次尝试的顺序（只有真的有 token 时才试后面那些） */
export function candidateStyles(): AuthStyle[] {
  // cookie 优先 —— 那才是 0.1.5 的真实机制；其余是给别的版本留的退路
  if (cookie) return ['cookie', 'none', 'query', 'bearer', 'x-dsh-token', 'authorization']
  return token ? ['none', 'query', 'bearer', 'x-dsh-token', 'authorization'] : ['none']
}

/** 把 style 应用一次，用来测某一种能不能通 */
export function withStyle<T extends { url: string; headers: Record<string, string> }>(req: T, s: AuthStyle): T {
  if (!token) return req
  const out = { url: req.url, headers: { ...req.headers } } as T
  if (s === 'query') out.url = withAuth(req.url)
  else if (s === 'bearer') out.headers.authorization = 'Bearer ' + token
  else if (s === 'x-dsh-token') out.headers['x-dsh-token'] = token
  else if (s === 'authorization') out.headers.authorization = token
  return out
}
