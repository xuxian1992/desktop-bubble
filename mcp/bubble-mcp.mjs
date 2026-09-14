#!/usr/bin/env node
/**
 * bubble-mcp —— 把「桌面气泡助手」的能力暴露给任意 agent 内核（DSH / Hermes）。
 *
 * stdio 上的 JSON-RPC 2.0（MCP 标准传输）。零依赖。
 * 通过 %APPDATA%/desktop-bubble/endpoint.json 找到气泡主进程的本地控制接口。
 *
 * 设计约束：**只注册真正实现了的工具**。做不到的能力宁可不出现，
 * 也不要注册一个永远失败的工具去浪费模型的回合（SOUL 里的「不撒谎」原则）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 数据目录必须和 Electron 的 app.getPath('userData') 算出同一个位置：
 *   Windows  %APPDATA%\desktop-bubble
 *   macOS    ~/Library/Application Support/desktop-bubble
 *   Linux    ~/.config/desktop-bubble
 * 允许用 DESKTOP_BUBBLE_DATA 覆盖，便于测试。
 */
const DATA_DIR =
  process.env.DESKTOP_BUBBLE_DATA ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'desktop-bubble')
    : process.platform === 'linux'
      ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'desktop-bubble')
      : join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'desktop-bubble'))
const ENDPOINT = join(DATA_DIR, 'endpoint.json')

function endpoint() {
  try {
    const j = JSON.parse(readFileSync(ENDPOINT, 'utf8'))
    if (typeof j.url === 'string') return j.url
  } catch { /* 气泡没在跑 */ }
  return null
}

async function control(path, init) {
  const base = endpoint()
  if (!base) throw new Error('桌面气泡助手没有在运行（找不到 ' + ENDPOINT + '）。请先启动气泡。')
  const res = await fetch(base + path, init)
  return res.json()
}

async function cmd(name, args) {
  const r = await control('/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: name, args: args || {} }),
  })
  if (!r.ok) throw new Error(r.error || 'command failed')
  return r.result
}

const TOOLS = [
  {
    name: 'bubble_state',
    description:
      '读取桌面气泡助手的实时状态：当前内核、屏幕监听开关、窗口形态与尺寸、当前会话与工作目录、' +
      '可见会话数、收件箱待答数。任何关于「你现在能不能看到屏幕 / 窗口多大 / 在哪个会话」的问题，' +
      '先调这个再回答，不要凭印象。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bubble_list_sessions',
    description: '列出气泡里可见的会话（已排除归档会话与已折叠的子代理会话），按最近更新排序。用于帮用户挑一个会话切过去。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bubble_open_session',
    description: '把气泡切换到指定会话（用户会立刻看到那个会话）。需要先知道 sessionId，可先用 bubble_list_sessions 查。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '要打开的会话 id' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_resize',
    description:
      '改变气泡窗口的形态或尺寸。形态：capsule=胶囊 96×96、bubble=气泡 380×560、panel=面板 720×640。' +
      '用户说「窗口调大点」「收起来」时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['capsule', 'bubble', 'panel'], description: '目标形态' },
      },
      required: ['preset'],
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_screenshot',
    description:
      '看一眼用户此刻的屏幕，返回一张压缩过的截图。' +
      'mode=foreground（默认）只抓当前前台窗口 —— 最省 token，而且**拍不到气泡自己**；' +
      'mode=screen 抓整个屏幕；mode=region 会让用户拖拽框选一块区域（最精准，' +
      '适合「看看这个报错」「这块 UI 怎么样」）。' +
      '注意：这是**一次性**的，不是持续监听 —— 你看不到用户之间发生了什么，也看不到他没让你看的时候。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['foreground', 'screen', 'region'],
          description: 'foreground=只抓前台窗口（默认，最省也最准）；screen=整个屏幕；region=让用户框选',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_visibility',
    description:
      '把气泡窗口收进托盘 / 重新显示。' +
      '气泡是**置顶窗口**，会一直浮在最上层 —— 当它挡住用户要看的内容、' +
      '或挡住你自己截图时，用 mode=hide 让它先让开，办完事再 mode=show 叫回来。' +
      '注意：隐藏后用户就看不到你的回复了，所以**别在对用户说话的时候把它收着**。',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['hide', 'show', 'toggle'] } },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_diary_search',
    description:
      '检索本地的「屏幕日记」—— 气泡在感知档位下记录的画面变化、窗口出现/关闭、错误事件。' +
      '**平时屏幕内容不会自动送给你**，用户问「我刚才那个报错是什么」时用这个去取。' +
      'query 留空则返回最近的若干条；命中的片段会附带当时的小截图。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如「错误」「构建」。留空取最近几条' },
        limit: { type: 'number', description: '最多返回几条，默认 6' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_set_monitor',
    description:
      '改变屏幕感知档位。off=关闭（只能手动截图）；passive=仅感知（本地记录，不上传，0 token）；' +

      '开感知是隐私敏感操作 —— 只在用户明确要求时做。',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['off', 'passive'] } },
      // 曾经有第三档 active，已合并进 passive（它的差异「每轮注入摘要」正是被去掉的开销）
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'bubble_inbox_list',
    description:
      '列出跨会话的待答项（有会话在等用户授权或回答问题）。这些不处理就会一直卡住，' +
      '所以气泡会主动提醒用户。只读，不代答。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function text(s) { return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] } }

async function callTool(name, args) {
  switch (name) {
    case 'bubble_state': {
      const s = await control('/state')
      // 状态块里**故意不再注入**监听行（每轮省 ~55 token），
      // 所以这里显式补上 —— 模型想确认「我现在能不能看」时，查这个工具就有答案。
      const p = s.perception
      const extra = p ? '\n\n监听：' + p.hint : ''
      return text(String(s.text) + extra)
    }
    case 'bubble_list_sessions': {
      const s = await control('/state')
      const list = (s.data?.sessions || []).map((x) => ({
        sessionId: x.sessionId, title: x.title, cwd: x.cwd, running: x.running, updatedAt: x.updatedAt,
      }))
      return text({ current: s.data?.current?.sessionId ?? null, sessions: list })
    }
    case 'bubble_open_session':
      return text(await cmd('open_session', { sessionId: args?.sessionId }))
    case 'bubble_resize':
      return text(await cmd('resize', { preset: args?.preset }))
    case 'bubble_screenshot': {
      const m = args?.mode ?? 'foreground'
      const img = await cmd('screenshot', { mode: m === 'region' ? 'region' : m })
      return {
        content: [
          { type: 'image', data: img.base64, mimeType: img.mediaType },
          { type: 'text', text: '截图已附上：' + img.label + '，压缩后 ' + img.width + '×' + img.height + '（' + Math.round(img.bytes / 1024) + ' KB）' },
        ],
      }
    }
    case 'bubble_visibility': {
      const r = await cmd('visibility', { mode: args?.mode })
      return text('气泡窗口现在' + (r.visible ? '可见' : '已收进托盘'))
    }
    case 'bubble_set_monitor': {
      const r = await cmd('set_monitor', { mode: args?.mode })
      return text('档位已切换为 ' + r.mode + '\n' + r.hint)
    }
    case 'bubble_diary_search': {
      const r = await cmd('diary_search', { query: args?.query ?? '', limit: args?.limit ?? 6 })
      if (!r.entries || r.entries.length === 0) {
        return text('屏幕日记是空的。如果档位是「关闭」，请先让用户调到「仅感知」再等一会儿。')
      }
      const content = [
        { type: 'text', text: r.entries.map((e) => e.time + ' [' + e.kind + '] ' + e.text).join('\n') },
      ]
      // 命中的关键帧直接作为图片附上（这是「按需取帧」的最后一公里）
      for (const e of r.entries.filter((x) => x.thumb).slice(0, 2)) {
        content.push({ type: 'image', data: e.thumb, mimeType: 'image/jpeg' })
      }
      return { content }
    }
    case 'bubble_inbox_list': {
      const s = await control('/state')
      return text({ inbox: s.data?.inbox ?? [] })
    }
    default:
      throw new Error('unknown tool: ' + name)
  }
}

/* ---------------- JSON-RPC over stdio ---------------- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    void handle(msg)
  }
})

/** 在飞的请求计数：stdin 收到 EOF 时不能立刻退出，否则会把没回完的调用砍掉 */
let pending = 0
let stdinEnded = false
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0)
}

async function handle(msg) {
  const { id, method, params } = msg || {}
  if (method === undefined) return
  // 通知（无 id）不回包
  pending++
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bubble-mcp', version: '0.1.0' },
        })
        return
      case 'notifications/initialized':
      case 'initialized':
        return
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools: TOOLS })
        return
      case 'tools/call': {
        const out = await callTool(params?.name, params?.arguments || {})
        reply(id, out)
        return
      }
      default:
        if (id !== undefined) replyError(id, -32601, 'method not found: ' + method)
        return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (id !== undefined) {
      // 工具执行失败要用 isError 内容返回，而不是 JSON-RPC 错误 —— 模型需要看到失败原因
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '调用失败：' + message }], isError: true } })
    }
  } finally {
    pending--
    maybeExit()
  }
}

process.stdin.on('end', () => {
  stdinEnded = true
  maybeExit()
})
