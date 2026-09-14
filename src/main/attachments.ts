import { clipboard, dialog, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Attachment, CapturedImage } from '../shared/types'
import { loadConfig } from './config'

/**
 * 附件识别 —— 三种策略（方案 §19.3）：
 *   image → 压缩后作为 image part 发出去
 *   text  → 小文件内联成代码块
 *   path  → 只发路径，让 AI 用自己的工具去读（往往最省 token 也最聪明）
 *
 * 注意：Electron 44 已**移除**同步的 clipboard.readImage / availableFormats，
 * 只剩异步 clipboard.read() → ClipboardItem[]。本文件按新 API 实现。
 */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

function fit(img: NativeImage, maxEdge: number): NativeImage {
  const size = img.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest <= maxEdge) return img
  const scale = maxEdge / longest
  return img.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: 'good',
  })
}

/** 把一段图片字节压成符合 token 纪律的附件 */
export function attachmentFromImageBuffer(buf: Buffer, name: string): Attachment | null {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const src = img.getSize()
  const cfg = loadConfig()
  const fitted = fit(img, cfg.imageMaxEdge)
  const jpeg = fitted.toJPEG(62)
  const size = fitted.getSize()
  return {
    kind: 'image',
    id: randomUUID(),
    name,
    label: name + ' · ' + size.width + '×' + size.height,
    base64: jpeg.toString('base64'),
    mediaType: 'image/jpeg',
    width: size.width,
    height: size.height,
    bytes: jpeg.length,
    sourceWidth: src.width,
    sourceHeight: src.height,
  }
}

/** 看起来像文本吗（有 NUL 就当二进制） */
function looksTextual(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

/** 按路径识别一个文件该走哪种策略 */
export function classifyPath(p: string): Attachment | null {
  try {
    const st = statSync(p)
    if (st.isDirectory()) {
      return { kind: 'path', id: randomUUID(), name: basename(p) + '/', path: p, bytes: 0 }
    }
    const name = basename(p)
    const ext = extname(p).toLowerCase()
    const cfg = loadConfig()

    if (IMAGE_EXT.has(ext)) {
      return attachmentFromImageBuffer(readFileSync(p), name)
    }

    if (st.size <= cfg.inlineLimitBytes) {
      const buf = readFileSync(p)
      if (looksTextual(buf)) {
        return { kind: 'text', id: randomUUID(), name, path: p, bytes: st.size, content: buf.toString('utf8') }
      }
    }

    return { kind: 'path', id: randomUUID(), name, path: p, bytes: st.size }
  } catch (err) {
    console.error('[attach] 读取失败 ' + p, err)
    return null
  }
}

export function classifyPaths(paths: string[]): Attachment[] {
  return paths.map(classifyPath).filter((x): x is Attachment => x !== null)
}

/** 渲染进程粘进来、但没有真实路径的图（网页复制的图） */
export function attachmentFromBase64(name: string, base64: string): Attachment | null {
  try {
    return attachmentFromImageBuffer(Buffer.from(base64, 'base64'), name || 'image.png')
  } catch {
    return null
  }
}

/** 系统文件选择器 */
export async function pickFiles(): Promise<Attachment[]> {
  const res = await dialog.showOpenDialog({
    title: '选择要发送给 AI 的文件',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: '添加',
  })
  if (res.canceled) return []
  return classifyPaths(res.filePaths)
}

/**
 * Ctrl+Alt+V：从系统剪贴板取附件。
 * 实测（Electron 44 / Windows）：
 *   资源管理器复制的文件 → types 里带 'text/uri-list'（file:///E:/.../x.json）
 *   复制的图片           → types 里带 'image/png'
 */
export async function attachmentsFromClipboard(): Promise<Attachment[]> {
  const out: Attachment[] = []
  let items: Electron.ClipboardItem[] = []
  try {
    items = await clipboard.read()
  } catch (err) {
    console.error('[attach] 读剪贴板失败', err)
    return out
  }

  for (const item of items) {
    const types = item.types ?? []
    const imgType = types.find((t) => t.startsWith('image/'))
    if (imgType) {
      try {
        const buf = await blobBytes(await item.getType(imgType))
        const a = attachmentFromImageBuffer(buf, 'clipboard.png')
        if (a) out.push(a)
      } catch (err) { console.error('[attach] 剪贴板图片解析失败', err) }
      continue
    }

    const uriType = types.find((t) => t === 'text/uri-list')
    if (uriType) {
      try {
        const text = (await blobBytes(await item.getType(uriType))).toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          const s = line.trim()
          if (!s || s.startsWith('#')) continue
          if (!s.startsWith('file:')) continue
          try { out.push(...classifyPaths([fileURLToPath(s)])) } catch { /* 非法 URL，跳过 */ }
        }
      } catch (err) { console.error('[attach] 剪贴板文件解析失败', err) }
    }
  }
  return out
}

/** getType 的返回类型是 Blob | ClipboardBookmark，需要窄化后再取字节 */
async function blobBytes(value: unknown): Promise<Buffer> {
  const b = value as Blob
  if (typeof b?.arrayBuffer !== 'function') throw new Error('剪贴板条目不是二进制 Blob')
  return Buffer.from(await b.arrayBuffer())
}

/** 把 CapturedImage（截图产物）转成统一附件 */
export function capturedToAttachment(img: CapturedImage): Attachment {
  return {
    kind: 'image',
    id: randomUUID(),
    name: 'screenshot.jpg',
    label: img.label,
    base64: img.base64,
    mediaType: img.mediaType,
    width: img.width,
    height: img.height,
    bytes: img.bytes,
    sourceWidth: img.sourceWidth,
    sourceHeight: img.sourceHeight,
  }
}
