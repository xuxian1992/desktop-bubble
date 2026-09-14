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
function resourceRoot(): string {
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

/** 把 yml 里我们那段标记块替换掉（没有就追加） */
function upsertBlock(yml: string, block: string): string {
  const b = yml.indexOf(MARK_BEGIN)
  const e = yml.indexOf(MARK_END)
  if (b >= 0 && e > b) {
    return yml.slice(0, b) + block + yml.slice(e + MARK_END.length).replace(/^\r?\n/, '')
  }
  return yml.replace(/\s*$/, '') + '\n\n' + block
}

export interface IntegrationResult { ok: boolean; detail: string; files?: string[] }

/** 灵魂标记块是否在位 */
export function isSoulInstalled(): boolean {
  try {
    return readFileSync(agentsPath(), 'utf8').includes(SOUL_BEGIN)
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

export function isIntegrated(): boolean {
  try {
    return readFileSync(profilePatchPath(), 'utf8').includes(MARK_BEGIN)
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
    try { yml = readFileSync(patchFile, 'utf8') } catch { /* 首次安装，文件可能不存在 */ }
    mkdirSync(dirname(patchFile), { recursive: true })
    const nodeExe = await resolveNodeExe()
    writeFileSync(patchFile, upsertBlock(yml, patchBlock(mcp, plugin, nodeExe)), 'utf8')

    // 灵魂：**插入标记块**，用户原有内容一字不动
    const soulPath = join(resourceRoot(), 'soul/SOUL.md')
    if (existsSync(soulPath)) {
      const target = agentsPath()
      mkdirSync(dirname(target), { recursive: true })
      let existing = ''
      try { existing = readFileSync(target, 'utf8') } catch { /* 首次安装没有这个文件 */ }
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
      const yml = readFileSync(patchFile, 'utf8')
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
      const cur = readFileSync(target, 'utf8')
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
