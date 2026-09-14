import { app } from 'electron'
import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Snapshot } from '../shared/types'
import type { BubbleState } from '../shared/types'
import { getHint, getMode } from './perception'

/** 气泡数据目录：%APPDATA%/desktop-bubble */
export function dataDir(): string {
  return app.getPath('userData')
}

export function contextPath(): string {
  return join(dataDir(), 'context.json')
}

export function endpointPath(): string {
  return join(dataDir(), 'endpoint.json')
}

/**
 * 渲染给模型看的运行时状态块。
 *
 * 这是「灵魂不撒谎」的物理保障 —— SOUL 里写死了一条铁律：
 * 任何关于「我能不能看到 / 我在哪个后端 / 窗口多大」的问题，先读这块再回答。
 */
export function buildStateText(snap: Snapshot | null, bubble: BubbleState): string {
  const lines: string[] = []
  lines.push('<bubble-state>')
  lines.push('后端：DSH（DeepSeek Harness）· ' + (snap?.bus.state === 'ready' ? '已连接' : '未连接'))
  // ⚠️ 这里**故意不再注入**「监听：…」那一行。
  //
  // 原因：它为每轮对话固定花掉约 55 token，而绝大多数轮次里没有任何值得一提的事。
  // 感知的价值不在「每轮报告状态」，而在「需要时查得到」。所以：
  //
  //   · 本地照常记录（窗口标题 / 画面变化 / 缩略图，全程 0 token）
  //   · 模型需要时用 bubble_state 或 bubble_diary_search 主动查
  //
  // 档位信息仍然保留在下面 data.perception 里，所以「查得到」这一点没有丢。
  lines.push('窗口形态：' + bubble.form + ' ' + bubble.bounds.width + '×' + bubble.bounds.height)

  const cur = snap?.current
  if (cur) {
    lines.push('当前会话：' + cur.title)
    if (cur.cwd) lines.push('工作目录：' + cur.cwd)
    lines.push('会话状态：' + (cur.loading ? '载入中' : cur.running ? '正在运行' : '空闲'))
  } else {
    lines.push('当前会话：无')
  }

  if (snap) {
    lines.push('可见会话数：' + snap.sessions.length + '（另有 ' + snap.subagentCount + ' 个子代理会话已折叠）')
    lines.push('收件箱：' + (snap.inbox.length ? snap.inbox.length + ' 条待答' : '空'))
  }
  // 屏幕日记的细节由 getHint() 一并说明，这里不再重复
  lines.push('</bubble-state>')
  return lines.join('\n')
}

/** 原子写入状态文件，供 dsh 插件每轮读取 */
export function writeContextFile(snap: Snapshot | null, bubble: BubbleState): void {
  const payload = {
    updatedAt: Date.now(),
    text: buildStateText(snap, bubble),
    data: {
      bus: snap?.bus ?? null,
      form: bubble.form,
      bounds: bubble.bounds,
      // 感知档位与说明 —— 不再注入上下文，但 bubble_state 工具会读它
      perception: { mode: getMode(), hint: getHint() },
      current: snap?.current
        ? { sessionId: snap.current.sessionId, title: snap.current.title, cwd: snap.current.cwd, running: snap.current.running }
        : null,
      sessionCount: snap?.sessions.length ?? 0,
      subagentCount: snap?.subagentCount ?? 0,
      inboxCount: snap?.inbox.length ?? 0,
    },
  }
  try {
    mkdirSync(dataDir(), { recursive: true })
    const file = contextPath()
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[context] 写状态文件失败', err)
  }
}
