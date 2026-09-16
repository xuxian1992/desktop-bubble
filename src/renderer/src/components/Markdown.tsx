/**
 * 气泡专用的 Markdown 渲染器。
 *
 * 两个刻意的选择：
 *   1. 自己解析，**完全不用 dangerouslySetInnerHTML** —— 零 XSS 面，零第三方依赖；
 *   2. 字号体系为 380px 气泡调过：H1 只比正文大 1px，不做夸张放大。
 *
 * 解析不了的内容一律按纯文本渲染，绝不吞内容。
 */
import { Fragment, type ReactNode } from 'react'

/* ---------------- 行内 ---------------- */

function inline(text: string, keyBase: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  let buf = ''
  let i = 0
  let k = 0
  const flush = (): void => {
    if (buf) { out.push(buf); buf = '' }
  }
  const key = (): string => keyBase + ':' + k++

  while (i < text.length) {
    const ch = text[i]

    // 行内代码
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) { flush(); out.push(<code key={key()}>{text.slice(i + 1, end)}</code>); i = end + 1; continue }
    }
    // 粗体
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2)
      if (end > i) { flush(); out.push(<strong key={key()}>{inline(text.slice(i + 2, end), key(), onLink)}</strong>); i = end + 2; continue }
    }
    // 删除线
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2)
      if (end > i) { flush(); out.push(<del key={key()}>{text.slice(i + 2, end)}</del>); i = end + 2; continue }
    }
    // 斜体（单个 *，且不吞掉 ** ）
    if (ch === '*' && !text.startsWith('**', i)) {
      const end = text.indexOf('*', i + 1)
      if (end > i + 1) { flush(); out.push(<em key={key()}>{text.slice(i + 1, end)}</em>); i = end + 1; continue }
    }
    // 链接
    if (ch === '[') {
      const close = text.indexOf(']', i)
      if (close > i && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2)
        if (end > close) {
          const label = text.slice(i + 1, close)
          const url = text.slice(close + 2, end)
          flush()
          out.push(
            <a key={key()} title={url} onClick={(e) => { e.preventDefault(); onLink?.(url) }}>
              {label}
            </a>,
          )
          i = end + 1
          continue
        }
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

/* ---------------- 块级 ---------------- */

interface CodeBlock { type: 'code'; lang: string; text: string }
interface ListBlock { type: 'list'; ordered: boolean; items: string[] }
interface TableBlock { type: 'table'; head: string[]; rows: string[][] }
interface TextBlock { type: 'heading'; level: number; text: string }
interface QuoteBlock { type: 'quote'; text: string }
interface ParaBlock { type: 'para'; text: string }
interface HrBlock { type: 'hr' }

type Block = CodeBlock | ListBlock | TableBlock | TextBlock | QuoteBlock | ParaBlock | HrBlock

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
}

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { i++; continue }

    // 围栏代码
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // 跳过收尾围栏
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { blocks.push({ type: 'heading', level: Math.min(3, h[1].length), text: h[2] }); i++; continue }
    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    // 引用（连续行合并）
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push({ type: 'quote', text: body.join('\n') })
      continue
    }
    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|/.test(lines[i + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows.push(splitRow(lines[i])); i++ }
      blocks.push({ type: 'table', head, rows })
      continue
    }
    // 列表（连续同类型合并）
    const listM = line.match(/^\s*([-*+]|\d+[.)])\s+/)
    if (listM) {
      const ordered = /\d/.test(listM[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; continue }
        if (/^\s+\S/.test(lines[i]) && items.length > 0) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue }
        break
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    // 段落（连续非空行合并）
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) { para.push(lines[i]); i++ }
    if (para.length) blocks.push({ type: 'para', text: para.join(' ') })
    else i++
  }
  return blocks
}

/**
 * 这段文本是一个 VCP 卡片（而不是普通 Markdown）吗？
 *
 * 判据刻意保守 —— 只认「明确的 HTML 容器」，不认零散的 `<b>` 之类：
 * 那些在普通回答里也常出现（比如讲 HTML 的时候），误判会把代码讲成卡片。
 */
function looksLikeVcp(text: string): boolean {
  return /<div[^>]*id=["']vcp-root["']/i.test(text)
}

/**
 * 去掉 <script> —— 我们不希望消息里的脚本在气泡里执行。
 *
 * VCP 规范本身就要求卡片**不写 script**（只用内联样式和 CSS），
 * 所以剥掉它不会影响任何正常卡片，却堵住了最直接的一条路。
 */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '')
}

/**
 * 消息渲染器。
 *
 * ⚠️ 关于 `dangerouslySetInnerHTML`：
 *
 * 这个组件原本**刻意不用它**（文件顶部写着「零 XSS 面」）。
 * 但 VCP 卡片要生效就必须真的把 HTML 挂进 DOM —— 这是这个功能本身的性质，
 * 不是可以绕过的实现细节。折中是：
 *
 *   ① 只在 `rawHtml` 开关打开时走这条路（关掉就退化成纯文本）
 *   ② 只对**明确带 `#vcp-root` 的文本**生效，普通回答一律走原来的解析器
 *   ③ 剥掉 <script>
 *
 * 三条都不是「彻底安全」，是「把面收窄到功能本身需要的那一点」。
 */
export function Markdown({
  text,
  markdown = true,
  rawHtml = true,
  onLink,
  onCopy,
}: {
  text: string
  markdown?: boolean
  rawHtml?: boolean
  onLink?: (url: string) => void
  onCopy?: (t: string) => void
}) {
  if (rawHtml && looksLikeVcp(text)) {
    return <div className="md md-vcp" dangerouslySetInnerHTML={{ __html: stripScripts(text) }} />
  }
  if (!markdown) return <div className="md"><p>{text}</p></div>
  const blocks = parse(text)
  return (
    <div className="md">
      {blocks.map((b, idx) => {
        const key = 'b' + idx
        switch (b.type) {
          case 'heading': {
            const Tag = (b.level === 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3') as 'h1'
            return <Tag key={key}>{inline(b.text, key, onLink)}</Tag>
          }
          case 'hr':
            return <hr key={key} />
          case 'code':
            return (
              <pre key={key}>
                <span className="bar">
                  <span>{b.lang || 'text'}</span>
                  <span className="cp" onClick={() => onCopy?.(b.text)}>复制</span>
                </span>
                <code>{b.text}</code>
              </pre>
            )
          case 'quote':
            return <blockquote key={key}>{inline(b.text, key, onLink)}</blockquote>
          case 'list': {
            const Tag = (b.ordered ? 'ol' : 'ul') as 'ul'
            return (
              <Tag key={key}>
                {b.items.map((it, j) => (
                  <li key={key + '-' + j}>{inline(it, key + '-' + j, onLink)}</li>
                ))}
              </Tag>
            )
          }
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>{b.head.map((c, j) => <th key={j}>{inline(c, key + 'h' + j, onLink)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>{row.map((c, ci) => <td key={ci}>{inline(c, key + ri + '_' + ci, onLink)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            )
          default:
            return <p key={key}>{inline(b.text, key, onLink)}</p>
        }
      })}
    </div>
  )
}
