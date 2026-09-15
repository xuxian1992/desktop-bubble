/**
 * VCP 卡片渲染器（气泡侧）。
 *
 * 浏览器里的 HTML 卡片由 dsh-raw-html 的前端补丁渲染；气泡有自己的渲染器，
 * 用不上那份补丁 —— 这个文件是气泡这一侧的对应实现。
 *
 * 三条硬规矩（与 Markdown.tsx 一致）：
 *   1. 全程不碰 dangerouslySetInnerHTML —— DOMParser 解析 → 消毒 → 造 React 元素。
 *      解析器和 React 都不执行 HTML 里的脚本，所以「模型写的 HTML」不等于「能跑的代码」；
 *   2. 卡片自带的 <style> 关进 Shadow DOM —— 模型写的 CSS 进不了气泡自己的界面；
 *   3. 解析不了就退回纯文本，绝不吞内容。
 *
 * 有意为之的差异（气泡不是浏览器，这几样做不到）：
 *   - 本机 CSP 是 img-src 'self' data: → 外链图片不加载，退化成一行占位说明；
 *   - KaTeX / Mermaid 那套 vendor 脚本不加载 → 公式、图表按源码显示；
 *   - 卡片自带的 @font-face 会被剥掉，字体由气泡本地注册（见 vcp.css 的 Lanxi-*）。
 */

import { Component, useEffect, useMemo, useRef, useState, createElement, Fragment, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* ---------------- 块识别（给 Markdown.tsx 用） ---------------- */

/** 这一行是不是 VCP 卡片开头（容错空白与引号风格）。 */
export function isVcpStart(line: string): boolean {
  return /^\s*<div\b[^>]*\bid\s*=\s*["']vcp-root["']/i.test(line)
}

/**
 * 从 start 行起吃掉一整张卡片，返回 HTML 与下一行的下标。
 *
 * 括号配平后才算一张卡：**流式中间态（还没闭合）返回 null** ——
 * 让调用方照常按文本渲染，于是用户看到的是「正在写」，而不是半张破卡。
 */
export function extractVcpBlock(lines: string[], start: number): { html: string; next: number } | null {
  if (!isVcpStart(lines[start] ?? '')) return null
  const buf: string[] = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    buf.push(line)
    depth += (line.match(/<div\b/gi) ?? []).length
    depth -= (line.match(/<\/div\s*>/gi) ?? []).length
    if (depth <= 0) return { html: buf.join('\n'), next: i + 1 }
  }
  return null
}

/* ---------------- 白名单 ---------------- */

/** 危险容器：连内容一起丢掉（内容本来就是代码而非文案）。 */
const DROP_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form',
  'textarea', 'select', 'option', 'audio', 'video', 'source', 'track',
  'noscript', 'template', 'foreignobject', 'canvas', 'frame', 'frameset',
])

/** 认得的元素（HTML 结构 + SVG 绘图）。不在名单里的 → 拆掉标签、留下孩子。 */
const KEEP_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'button', 'caption',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark', 'meter', 'nav', 'ol', 'p', 'picture',
  'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
  'ul', 'var', 'wbr',
  // SVG
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'filter', 'fegaussianblur',
  'fecolormatrix', 'feblend', 'feoffset', 'femerge', 'femergenode', 'feflood', 'fecomposite',
  'fedropshadow', 'use', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'textpath', 'title',
  'desc', 'image',
])

/** 属性名特例：HTML 里带连字符、React 里要驼峰的。 */
const ATTR_MAP: Record<string, string> = {
  for: 'htmlFor', tabindex: 'tabIndex', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', readonly: 'readOnly', contenteditable: 'contentEditable',
  autocomplete: 'autoComplete', enctype: 'encType', novalidate: 'noValidate', spellcheck: 'spellCheck',
  datetime: 'dateTime', accesskey: 'accessKey', autofocus: 'autoFocus', cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing', crossorigin: 'crossOrigin', usemap: 'useMap', frameborder: 'frameBorder',
}

/** 一律丢弃的属性。 */
const DROP_ATTRS = new Set(['srcset', 'xmlns', 'xmlns:xlink', 'srcdoc', 'action', 'formaction', 'ping', 'download'])

/** 允许出现的 URL 协议（其余一律丢，尤其 javascript:）。 */
const SAFE_URL = /^(https?:|mailto:|tel:|data:image\/|blob:|#|\/|\.\/|\.\.\/)/i

/* ---------------- 消毒 ---------------- */

/** 按 ; 切 CSS 声明，但不切进括号和引号里的分号。 */
function splitDecls(text: string): string[] {
  const out: string[] = []
  let buf = ''
  let depth = 0
  let quote = ''
  for (const ch of text) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf)
  return out
}

/** style 字符串 → React 样式对象（顺手掐掉「跑到窗口外面去」和危险协议）。 */
function parseStyle(text: string): CSSProperties {
  const out: Record<string, string> = {}
  for (const decl of splitDecls(text)) {
    const at = decl.indexOf(':')
    if (at <= 0) continue
    const prop = decl.slice(0, at).trim()
    let value = decl.slice(at + 1).trim()
    if (!prop || !value) continue
    if (/^position$/i.test(prop) && /fixed|sticky/i.test(value)) continue
    if (/^z-index$/i.test(prop) && Number.parseInt(value, 10) >= 100) continue
    if (/javascript\s*:|expression\s*\(/i.test(value)) continue
    value = value.replace(/\/fonts\//gi, 'fonts/')
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out[key] = value
  }
  return out as CSSProperties
}

/** 卡片自带的 CSS：剥掉外链导入与 @font-face（字体由气泡本地注册），其余原样留下。 */
function cleanCss(text: string): string {
  return text
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/javascript\s*:|expression\s*\(/gi, '')
    .replace(/\/fonts\//gi, 'fonts/')
}

/** VCP 的按钮桥：onclick="input('...')" → 点一下就把这句话发给会话。 */
const INPUT_RE = /^input\s*\(\s*['"]([\s\S]*?)['"]\s*\)\s*;?\s*$/

function bridgeInput(text: string): void {
  const api = (window as unknown as { bubble?: { prompt?: (t: string, a: unknown[]) => void } }).bubble
  try {
    api?.prompt?.(text, [])
  } catch {
    /* 会话没就绪就算了 —— 不给气泡添乱 */
  }
}

/** 外链图片在气泡里加载不了（CSP 只放行 self / data:），退化成一行说明，别留破图。 */
function CardImage({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <span style={{ display: 'inline-block', opacity: 0.6, fontSize: '0.85em' }}>🖼 {alt || '图片'}（外链，气泡内不加载）</span>
  }
  return <img src={src} alt={alt} style={style} onError={() => setFailed(true)} />
}

/** 一个 DOM 节点 → React 节点。 */
function convert(node: Node, key: string, css: string[]): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue
  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const el = node as Element
  const tag = el.localName.toLowerCase()
  if (DROP_TAGS.has(tag)) return null

  // <style> 不当元素渲染，抽出来交给 Shadow DOM
  if (tag === 'style') {
    const text = cleanCss(el.textContent ?? '').trim()
    if (text) css.push(text)
    return null
  }

  const children: ReactNode[] = []
  let i = 0
  for (const child of Array.from(el.childNodes)) children.push(convert(child, key + '.' + i++, css))

  // 不认得的标签：拆掉自己，留下孩子
  if (!KEEP_TAGS.has(tag)) return createElement(Fragment, { key }, ...children)

  const props: Record<string, unknown> = { key }
  let alt = ''
  let src = ''
  let style: CSSProperties | undefined

  for (const attr of Array.from(el.attributes)) {
    const raw = attr.name
    const name = raw.toLowerCase()
    const value = attr.value ?? ''

    if (name.startsWith('on')) {
      // 只放行 input('...') 这一条受控通道
      if (name === 'onclick') {
        const m = INPUT_RE.exec(value.trim())
        if (m) {
          props.onClick = () => bridgeInput(m[1])
          props.role = 'button'
        }
      }
      continue
    }
    if (DROP_ATTRS.has(name)) continue
    if (name === 'style') { style = parseStyle(value); continue }
    if (name === 'class' || name === 'classname') { props.className = value; continue }
    if (name === 'href' || name === 'src' || name === 'xlink:href') {
      const raw2 = value.trim()
      if (raw2.startsWith('//') || !SAFE_URL.test(raw2)) continue // 协议相对地址也拦掉
      const next = value.replace(/\/fonts\//gi, 'fonts/')
      if (name === 'xlink:href') props.xlinkHref = next
      else if (name === 'href') props.href = next
      else { src = next; props.src = next }
      continue
    }
    if (name === 'alt') { alt = value; props.alt = value; continue }
    // SVG 的驼峰属性（viewBox 之类）解析器会还原本名，先认这个，再退回 kebab→camel
    const mapped = ATTR_MAP[name] ?? (/[A-Z]/.test(raw)
      ? raw
      : name.includes('-') && !name.startsWith('data-') && !name.startsWith('aria-')
        ? name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        : name)
    props[mapped] = value
  }

  if (style && Object.keys(style).length) props.style = style

  if (tag === 'img') {
    if (!src) return null
    return createElement(CardImage, { key, src, alt, style })
  }
  return createElement(tag, props, ...children)
}

/** HTML → { 卡片节点, 卡片 CSS }。解析失败由调用方兜底；导出供回归测试直接调用。 */
export function buildVcpTree(html: string): { nodes: ReactNode[]; css: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const css: string[] = []
  const nodes: ReactNode[] = []
  let i = 0
  for (const child of Array.from(doc.body.childNodes)) nodes.push(convert(child, 'v' + i++, css))
  return { nodes, css: css.join('\n') }
}

function CardBody({ html }: { html: string }): ReactElement {
  const { nodes, css } = useMemo(() => {
    try {
      return buildVcpTree(html)
    } catch {
      // 解析炸了就退回源码 —— 和 Markdown.tsx 同一条规矩：绝不吞内容
      return { nodes: [createElement('pre', { key: 'raw' }, html)] as ReactNode[], css: '' }
    }
  }, [html])
  return createElement(Fragment, null, css ? createElement('style', { key: 'css' }, css) : null, ...nodes)
}

/** 卡片里出任何意外都不能连累气泡本身 —— 兜底渲染源码。 */
class CardBoundary extends Component<{ html: string; children: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (this.state.failed) return <pre className="vcp-fallback">{this.props.html}</pre>
    return this.props.children
  }
}

/**
 * 渲染一张 VCP 卡片。
 *
 * 卡片内容挂在 Shadow DOM 里 —— 模型写的 CSS 只能在卡片内部生效，
 * 碰不到气泡自己的界面；React 用 portal 把子树送进去，事件照常冒泡。
 */
export function VcpCard({ html }: { html: string }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [shadow, setShadow] = useState<ShadowRoot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setShadow(host.shadowRoot ?? host.attachShadow({ mode: 'open' }))
  }, [])

  return (
    <div ref={hostRef} className="vcp-card">
      <CardBoundary html={html}>
        {shadow ? createPortal(<CardBody html={html} />, shadow) : null}
      </CardBoundary>
    </div>
  )
}
