/**
 * VCP 卡片的字体注册（气泡侧）。
 *
 * 字体是二进制，**不进版本库** —— 它们本来就随 dsh-raw-html 插件分发，
 * 由 build/sync-fonts.cjs 从插件目录同步到 renderer 的 public/fonts/，
 * Vite 构建时原样拷到 out/renderer/fonts/（不做任何模块解析）。
 *
 * 所以这里在运行时拼一份 @font-face 注入 document：
 *   · 缺字体不报错 —— 浏览器拿不到文件就回退系统字体，构建完全不受影响；
 *   · 相对路径相对「文档 URL」，开发（http://localhost:5173/）与打包
 *     （file:///…/out/renderer/index.html）两种形态都成立；
 *   · 同源，CSP 的 font-src 'self' 直接放行。
 *
 * family 名 = 文件名（与插件 DESIGN.md 的字体清单一一对应）。
 */
const FAMILIES = [
  'Lanxi-WenKai', 'Lanxi-WenKaiLight', 'Lanxi-MaShanZheng',
  'Lanxi-HeiTi', 'Lanxi-HeiTiLight', 'Lanxi-HeiTiBold', 'Lanxi-GreatVibes',
  'Lanxi-可宋', 'Lanxi-朗宋', 'Lanxi-品宋', 'Lanxi-颜宋',
  'Lanxi-静黑超细', 'Lanxi-点黑', 'Lanxi-超粗黑',
  'Lanxi-卡通', 'Lanxi-叮叮', 'Lanxi-喵喵',
  'Lanxi-春兰茅坤', 'Lanxi-鱼尾行书', 'Lanxi-狂侠体', 'Lanxi-鱼尾行书繁',
  'Lanxi-暗恋初夏', 'Lanxi-秀英体', 'Lanxi-初心少女', 'Lanxi-丫丫体',
]

/** 把 26 款内置字体的 @font-face 注入 document（重复调用无副作用）。 */
export function installVcpFonts(): void {
  if (document.getElementById('vcp-fonts')) return
  const css = FAMILIES.map(
    (f) => "@font-face{font-family:'" + f + "';src:url('fonts/" + encodeURIComponent(f) + ".woff2') format('woff2');font-display:swap}",
  ).join('\n')
  const el = document.createElement('style')
  el.id = 'vcp-fonts'
  el.textContent = css
  document.head.appendChild(el)
}
