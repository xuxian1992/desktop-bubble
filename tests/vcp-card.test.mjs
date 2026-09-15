/**
 * VcpCard 回归测试 —— 消毒逻辑是安全相关代码，改了就得跑这一遍。
 *
 *   node tests/vcp-card.test.mjs
 *
 * 环境：把 VcpCard.tsx 用 esbuild 打成 Node 能跑的 ESM，
 * DOM 用 DSH 侧现成的 domino（气泡本身不带 DOM 实现）。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { isValidElement } from 'react'

const DOMINO_DIR = 'C:/Users/xxacm/.dsh/profiles/node_modules/'
const BUNDLE = 'out/vcp-card.test.bundle.mjs'

const req = createRequire(DOMINO_DIR)
if (!existsSync(DOMINO_DIR + '@mixmark-io/domino')) {
  console.log('SKIP: 找不到 domino（' + DOMINO_DIR + '），无法提供 DOMParser')
  process.exit(0)
}
const domino = req('@mixmark-io/domino')
globalThis.Node = domino.impl?.Node ?? { TEXT_NODE: 3, ELEMENT_NODE: 1 }
globalThis.DOMParser = class {
  parseFromString(html) {
    return domino.createDocument(html)
  }
}

await build({
  entryPoints: ['src/renderer/src/components/VcpCard.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  outfile: BUNDLE,
  logLevel: 'warning',
})
const { buildVcpTree, extractVcpBlock, isVcpStart } = await import(pathToFileURL(BUNDLE).href)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))) }
}

/** 把 React 树按 type 找出来 */
function all(nodes, out = []) {
  for (const n of nodes) {
    if (isValidElement(n)) {
      out.push(n)
      const c = n.props?.children
      all(Array.isArray(c) ? c : c === undefined || c === null ? [] : [c], out)
    }
  }
  return out
}
function find(nodes, type) {
  return all(nodes).find((n) => n.type === type)
}

/* ---------- 1. 块识别 ---------- */
console.log('块识别')
const one = ['<div id="vcp-root"><b>hi</b></div>', 'after']
ok('单行卡片', extractVcpBlock(one, 0)?.html === '<div id="vcp-root"><b>hi</b></div>')
ok('单行卡片后指针', extractVcpBlock(one, 0)?.next === 1)
const nested = ['<div id="vcp-root">', '  <div class="a">', '    <div>x</div>', '  </div>', '</div>', 'tail']
ok('嵌套 div 配平', extractVcpBlock(nested, 0)?.next === 5)
ok('未闭合（流式）返回 null', extractVcpBlock(['<div id="vcp-root">', '  <b>x'], 0) === null)
ok('非卡片行不误判', extractVcpBlock(['<div class="x">y</div>'], 0) === null)
ok('单引号 id 也认', isVcpStart("<div  id='vcp-root'>"))

/* ---------- 2. 消毒 ---------- */
console.log('消毒')
const html = [
  '<div id="vcp-root" style="position:fixed;z-index:9999;color:#fff;font-family:Lanxi-WenKai">',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.com"></iframe>',
  '<img src="https://cdn.example/a.png" onerror="alert(1)" alt="图">',
  '<a href="javascript:alert(1)">bad</a>',
  '<a href="https://ok.example">good</a>',
  '<button onclick="input(\'来一份\')">点我</button>',
  '<button onclick="alert(1)">坏按钮</button>',
  '<my-widget><i>里面</i></my-widget>',
  '<svg viewBox="0 0 10 10" stroke-width="2"><circle cx="5" cy="5" r="4"/></svg>',
  '<style>#vcp-root{color:red} @import url(https://evil.com/x.css); @font-face{font-family:X;src:url(/fonts/X.woff2)}</style>',
  '</div>',
].join('\n')

const { nodes, css } = buildVcpTree(html)
const types = all(nodes).map((n) => (typeof n.type === 'string' ? n.type : 'Comp:' + n.type.name))

ok('根 div 保留', find(nodes, 'div') !== undefined)
ok('script 被丢掉', !types.includes('script'))
ok('iframe 被丢掉', !types.includes('iframe'))
ok('未知名标签被拆开（孩子还在）', !types.includes('my-widget') && types.includes('i'))
ok('svg + circle 都在', types.includes('svg') && types.includes('circle'))

const root = find(nodes, 'div')
ok('style: position:fixed 被掐', root.props.style?.position === undefined)
ok('style: z-index:9999 被掐', root.props.style?.zIndex === undefined)
ok('style: color 保留', root.props.style?.color === '#fff')
ok('style: font-family → fontFamily', root.props.style?.fontFamily === 'Lanxi-WenKai')

const buttons = all(nodes).filter((n) => n.type === 'button')
ok('button 数 = 2', buttons.length === 2, buttons.length)
ok('input() 桥接成 onClick', typeof buttons[0]?.props.onClick === 'function')
ok('其它 onclick 被丢掉', buttons[1]?.props.onClick === undefined)

const anchors = all(nodes).filter((n) => n.type === 'a')
ok('javascript: 链接的 href 被丢', anchors.find((a) => a.props.children === 'bad')?.props.href === undefined)
ok('https 链接的 href 保留', anchors.find((a) => a.props.children === 'good')?.props.href === 'https://ok.example')

const img = all(nodes).find((n) => typeof n.type === 'function' && n.type.name === 'CardImage')
ok('img 换成 CardImage 组件', img !== undefined)
ok('img 的 onerror 没跟过来', img?.props.onerror === undefined && img?.props.onError === undefined)
ok('img 带 alt', img?.props.alt === '图')

const svg = find(nodes, 'svg')
ok('svg viewBox 保留', svg?.props.viewBox === '0 0 10 10')
ok('svg stroke-width → strokeWidth', svg?.props.strokeWidth === '2')

ok('卡片 CSS 已抽出（不留在元素里）', css.includes('#vcp-root{color:red}'))
ok('@import 被剥掉', !css.includes('@import'))
ok('@font-face 被剥掉（字体由气泡注册）', !css.includes('@font-face'))
ok('style 标签不当作元素渲染', !types.includes('style'))

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
