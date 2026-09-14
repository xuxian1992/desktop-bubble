import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { resolveNodeExe } from './dsh-manager'

/**
 * dsh 集成自配置。
 *
 * 安装版的资源不在开发目录里，所以**先把 mcp/ 与 plugin/ 复制到用户数据目录**，
 * 再把指向它们的条目写进 dsh 的 profile 叠加层 —— 这样安装路径换来换去都不影响。
 *
 * 三件事：
 *   1. MCP 服务端 + 状态块插件 → %APPDATA%/desktop-bubble/integration/
 *   2. cordis.patch.yml 里维护一段带标记的 insert 块（可反复更新、可整段移除）
 *   3. 灵魂 → ~/.dsh/AGENTS.md（写入前先备份）
 */

const MARK_BEGIN = '# ==== 桌面气泡助手（自动生成，请勿手改）===='
const MARK_END = '# ==== 桌面气泡助手 · 结束 ===='

/**
 * 灵魂也用标记块包起来 —— **绝不能整文件覆盖或删除**。
 *
 * ~/.dsh/AGENTS.md 是用户自己的东西：里面可能有他写给模型的项目规则。
 * 上一版的做法是「文件里出现『桌面气泡助手』就把整个文件删掉」——
 * 那会连带毁掉用户自己的内容。改成和 yml 一样的标记块：装=插入/替换，卸=只摘掉自己那段。
 */
const SOUL_BEGIN = '<!-- ==== 桌面气泡助手 · 开始 ==== -->'
const SOUL_END = '<!-- ==== 桌面气泡助手 · 结束 ==== -->'

/** 把灵魂作为标记块插进已有内容（已有则替换），其余内容一字不动 */
export function upsertSoulBlock(existing: string, soul: string): string {
  const block = SOUL_BEGIN + '\n' + soul.trim() + '\n' + SOUL_END
  const b = existing.indexOf(SOUL_BEGIN)
  const e = existing.indexOf(SOUL_END)
  if (b >= 0 && e > b) return existing.slice(0, b) + block + existing.slice(e + SOUL_END.length)
  if (!existing.trim()) return block + '\n'
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n'
}

/** 只摘掉我们那一段，其它内容原样保留 */
export function stripSoulBlock(existing: string): string {
  const b = existing.indexOf(SOUL_BEGIN)
  const e = existing.indexOf(SOUL_END)
  if (b < 0 || e < b) return existing
  return (existing.slice(0, b) + existing.slice(e + SOUL_END.length)).replace(/\n{3,}/g, '\n\n')
}

export function integrationDir(): string {
  return join(app.getPath('userData'), 'integration')
}

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function profilePatchPath(): string {
  return join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
}

function agentsPath(): string {
  return join(dshHome(), 'AGENTS.md')
}

/** 自带资源目录：开发时在项目根，打包后在 process.resourcesPath（extraResources 落在这里） */
export function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
}

function copyInto(name: string, rel: string): string {
  const src = join(resourceRoot(), rel)
  const dst = join(integrationDir(), name)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return dst
}

function patchBlock(mcpPath: string, pluginPath: string, nodeExe: string): string {
  const p = (s: string): string => s.replace(/\\/g, '/')
  return [
    MARK_BEGIN,
    '- insert:',
    '    - id: bubble-context',
    "      name: 'file:///" + p(pluginPath) + "'",
    '- insert:',
    '    - id: mcp-bubble',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: bubble',
    '        transport: stdio',
    "        command: '" + nodeExe.replace(/\\/g, '\\\\') + "'",
    '        args:',
    "          - '" + mcpPath.replace(/\\/g, '\\\\') + "'",
    "        cwd: '" + integrationDir().replace(/\\/g, '\\\\') + "'",
    '        toolCallTimeoutMs: 30000',
    MARK_END,
    '',
  ].join('\n')
}

/**
 * 剥掉开头的 BOM。
 *
 * ⚠️ 必须做：Node 的 `readFileSync(p, 'utf8')` **不会**剥 BOM，
 * 而 dsh 用 js-yaml 解析这个补丁文件 —— **开头多一个 \uFEFF 就直接抛错、dsh 起不来**。
 * PowerShell 的 `Set-Content -Encoding utf8` 默认写 BOM（我们早期版本的清理脚本就是这么写的），
 * 一旦沾上，我们的 upsert 会把它原样读回来再写回去 —— **永久留在文件里**。
 */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 去掉注释行与空白后，文件真正的「实体内容」 */
function meaningfulYaml(yml: string): string {
  return yml
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .trim()
}

/**
 * 把 yml 里我们那段标记块替换掉；没有就插进去。
 *
 * ⚠️ 这里是曾经把 dsh 弄崩过的地方。原来「没有标记块就一律追加」，于是：
 *
 *   dsh 默认的 cordis.patch.yml 内容是 `[]`（一个空数组 —— **本身已经是完整文档**）。
 *   卸载时我们把标记块切掉、留下 `[]`；重装时又往它后面追加 `- insert:` ——
 *   一个文件里出现两个顶层节点，YAML 直接拒绝：
 *
 *     YAMLException: end of the stream or a document separator is expected (7:1)
 *
 *   而 dsh 是在**启动时**读这个文件的，所以表现是「dsh 起不来」，跟接入本身看不出关系。
 *
 * 所以：现有内容为空、或就是一个 `[]` 时，**整体替换**，绝不追加。
 */
function upsertBlock(yml: string, block: string): string {
  const b = yml.indexOf(MARK_BEGIN)
  const e = yml.indexOf(MARK_END)
  if (b >= 0 && e > b) {
    return yml.slice(0, b) + block + yml.slice(e + MARK_END.length).replace(/^\r?\n/, '')
  }
  const rest = meaningfulYaml(yml)
  if (rest === '' || rest === '[]') return block
  return yml.replace(/\s*$/, '') + '\n\n' + block
}

export interface IntegrationResult { ok: boolean; detail: string; files?: string[] }

/** 灵魂标记块是否在位 */
export function isSoulInstalled(): boolean {
  try {
    return stripBom(readFileSync(agentsPath(), 'utf8')).includes(SOUL_BEGIN)
  } catch {
    return false
  }
}

/**
 * 幂等自愈：缺什么补什么。
 *
 * 为什么需要：更新版本 = 卸载 + 重装。卸载必须撤掉集成（否则残留的插件路径会让
 * `dsh web` 启动报错），但重装不会自动恢复 —— 结果是模型既收不到状态块，
 * 也没有灵魂去解释它。表现就是「明明开着屏幕共享，却忘了自己有视觉能力」。
 */
export async function ensureIntegration(): Promise<{ repaired: boolean; detail: string }> {
  const patchOk = isIntegrated()
  const soulOk = isSoulInstalled()
  if (patchOk && soulOk) return { repaired: false, detail: '接入完整' }
  const missing: string[] = []
  if (!patchOk) missing.push('插件注册')
  if (!soulOk) missing.push('灵魂')
  const r = await installIntegration()
  return {
    repaired: r.ok,
    detail: r.ok ? '已自动补回：' + missing.join(' + ') : '自动修复失败：' + r.detail,
  }
}

/**
 * 接入是否「既在、又没把文件写坏」。
 *
 * ⚠️ 只检查「标记在不在」是不够的 —— 旧版的 upsert 会往 `[]` 后面追加，
 * 生成一个**两个顶层节点**的坏文件。那种文件里标记是**在**的，
 * 于是这里会报「已接入」、自愈不会触发，而 dsh 每次启动都崩。
 *
 * 所以：只要发现 `[]` 与我们的标记并存，就判定为需要重写。
 */
export function isIntegrated(): boolean {
  try {
    const yml = stripBom(readFileSync(profilePatchPath(), 'utf8'))
    if (!yml.includes(MARK_BEGIN)) return false
    // 坏形态：空的 flow-sequence 和我们的块并列 —— 两个顶层节点，YAML 会拒绝
    const before = yml.slice(0, yml.indexOf(MARK_BEGIN))
    if (meaningfulYaml(before) === '[]') return false
    return true
  } catch {
    return false
  }
}

export async function installIntegration(): Promise<IntegrationResult> {
  try {
    mkdirSync(integrationDir(), { recursive: true })
    const mcp = copyInto('bubble-mcp.mjs', 'mcp/bubble-mcp.mjs')
    const plugin = copyInto('bubble-context.mjs', 'plugin/bubble-context.mjs')

    const patchFile = profilePatchPath()
    let yml = ''
    try { yml = stripBom(readFileSync(patchFile, 'utf8')) } catch { /* 首次安装，文件可能不存在 */ }
    mkdirSync(dirname(patchFile), { recursive: true })
    const nodeExe = await resolveNodeExe()
    writeFileSync(patchFile, upsertBlock(yml, patchBlock(mcp, plugin, nodeExe)), 'utf8')

    // 灵魂：**插入标记块**，用户原有内容一字不动
    const soulPath = join(resourceRoot(), 'soul/SOUL.md')
    if (existsSync(soulPath)) {
      const target = agentsPath()
      mkdirSync(dirname(target), { recursive: true })
      let existing = ''
      try { existing = stripBom(readFileSync(target, 'utf8')) } catch { /* 首次安装没有这个文件 */ }
      const next = upsertSoulBlock(existing, readFileSync(soulPath, 'utf8'))
      // 内容没变就不写 —— 避免无谓地改动用户的文件
      if (next !== existing) writeFileSync(target, next, 'utf8')
    }

    return { ok: true, detail: '已接入 dsh（用 ' + nodeExe + '，重启 dsh web 后生效）', files: [mcp, plugin, patchFile, agentsPath()] }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export function removeIntegration(): IntegrationResult {
  try {
    const patchFile = profilePatchPath()
    try {
      const yml = stripBom(readFileSync(patchFile, 'utf8'))
      const b = yml.indexOf(MARK_BEGIN)
      const e = yml.indexOf(MARK_END)
      if (b >= 0 && e > b) {
        writeFileSync(patchFile, (yml.slice(0, b) + yml.slice(e + MARK_END.length)).replace(/\n{3,}/g, '\n\n'), 'utf8')
      }
    } catch { /* 文件不存在就算了 */ }

    // 卸灵魂：**只摘掉自己那一段**。
    // 上一版是「文件里提到气泡就删掉整个文件」—— 会毁掉用户自己写的内容。
    const target = agentsPath()
    try {
      const cur = stripBom(readFileSync(target, 'utf8'))
      const next = stripSoulBlock(cur)
      if (next !== cur) {
        if (next.trim()) writeFileSync(target, next, 'utf8')
        else rmSync(target, { force: true })   // 摘完确实空了才删文件
      }
    } catch { /* ignore */ }

    rmSync(integrationDir(), { recursive: true, force: true })
    return { ok: true, detail: '已移除 dsh 集成' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
