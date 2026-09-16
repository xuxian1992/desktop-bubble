/**
 * 供应商与模型 —— 直接对接 dsh 自己的接口，不自己造一套配置。
 *
 * 为什么必须走 dsh 的接口（而不是自己写 settings.yaml）：
 *
 *   · dsh 的模型配置分两层：**路由**（provider）与**凭据**（credential）。
 *     路由写在 settings.yaml 的 `llm-pi-ai.providers.<id>` 或 `llm-deepseek` 下；
 *     而密钥**永远不进 settings.yaml** —— 它经 `credentials.set` 只写地存进凭据库，
 *     由 profile 的 `apiKeyEnv` 引用。自己写文件会把密钥落到明文配置里。
 *
 *   · 写配置要走 `settings.mutate`（逐字段的路径 op，且带 revision 做并发校验）。
 *     直接改文件既拿不到冲突检测，也可能把 dsh 认不出的结构写进去。
 *
 *   · 模型列表能**直接从供应商端点问出来**（`llm.discoverModels`），
 *     前提是走 OpenAI 兼容的 /v1/models。这就是「自动拉取」的实现。
 *
 * 接口形状是实测出来的，不是猜的：
 *   llm.providers                       → { providers: [{provider, displayName, settingsNs, settingsPath, active, declared}] }
 *   llm.discoverModels {settingsNs, provider} → { models: [{id, name, contextWindow?, maxTokens?}] }
 *   credentials.describe {refs}         → { credentials: { <ref>: {configured, writable, source?} } }
 *   credentials.set {ref, value}        → 唯一的密钥写入通道（只写，不回读）
 */
import type { DshClient } from './dsh/client'

export interface ProviderEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: Array<string | number>
  /** 已经配置好、可以用的 */
  active: boolean
  /** 用户在界面上自己声明的路由（相对内置目录） */
  declared: boolean
}

export interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
}

/** 拉取供应商目录（内置 + 用户自定义） */
export async function listProviders(c: DshClient): Promise<ProviderEntry[]> {
  const v = await c.value<{ providers?: ProviderEntry[] }>('llm.providers', {})
  return Array.isArray(v?.providers) ? v.providers : []
}

/**
 * 问供应商端点「你有哪些模型」。
 *
 * `provider` 传路由 id（如 `zai`、`deepseek`）。返回空数组表示问不到 ——
 * 可能是没填密钥、端点不通、或者不是 OpenAI 兼容的 /v1/models。
 * 这三种情况对用户来说是不同的事，所以错误原因要原样带回去。
 */
export async function discoverModels(
  c: DshClient,
  settingsNs: string,
  provider: string,
): Promise<{ models: DiscoveredModel[]; error?: string }> {
  const r = await c.call<{ models?: DiscoveredModel[] }>('llm.discoverModels', { settingsNs, provider }, 30_000)
  if (!r.ok) return { models: [], error: r.error.message }
  return { models: r.value?.models ?? [] }
}

/**
 * 由路由 id 派生凭据引用名 —— **这只是兜底**。
 *
 * ⚠️ 不要拿它当主路径。dsh 的真实规则是：**profile 里写了 `apiKeyEnv` 就用那个名字**，
 * 只有没写时才派生成 `<ROUTE>_API_KEY`。
 *
 * 我一开始直接硬推导，结果内置的 DeepSeek 供应商被推成 `DEEPSEEK_OFFICIAL_API_KEY`，
 * 而它真正用的是 `DEEPSEEK_API_KEY` —— 密钥会存到一个**没人读的名字**下，
 * 用户填了也不生效，且看不出哪里错。
 *
 * 正确做法是先查 `settings.describe` 里的 `apiKeyEnv`（见 resolveApiKeyEnv）。
 */
export function credentialRefFor(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

/**
 * 查出某个路由真正使用的凭据引用名。
 *
 * 两个家族的位置不同：
 *   llm-deepseek           →  settingsNs 的**顶层** `apiKeyEnv`
 *   llm-pi-ai 的每个路由    →  `providers.<id>.apiKeyEnv`（即 settingsPath 指向的那一层）
 *
 * 所以按 `settingsPath` 逐层走进去取 `apiKeyEnv` 就能同时覆盖两者。
 * 取不到才退回派生 —— 那条路是 dsh 给「用户自己声明、没写引用」的路由准备的。
 */
export async function resolveApiKeyEnv(c: DshClient, p: ProviderEntry): Promise<string> {
  try {
    const d = await c.value<{ namespaces?: Array<{ ns: string; value?: unknown }> }>('settings.describe', {})
    const ns = d?.namespaces?.find((n) => n.ns === p.settingsNs)
    let node: unknown = ns?.value
    for (const seg of p.settingsPath ?? []) {
      if (node && typeof node === 'object') node = (node as Record<string, unknown>)[String(seg)]
    }
    const env = node && typeof node === 'object' ? (node as Record<string, unknown>).apiKeyEnv : undefined
    if (typeof env === 'string' && env.trim()) return env.trim()
  } catch { /* 拿不到就走兜底 */ }
  return credentialRefFor(p.provider)
}

export interface CredentialState { configured: boolean; writable: boolean; source?: string }

/** 批量查凭据状态（只回状态，不回值） */
export async function describeCredentials(c: DshClient, refs: string[]): Promise<Record<string, CredentialState>> {
  const v = await c.value<{ credentials?: Record<string, CredentialState> }>('credentials.describe', { refs })
  return v?.credentials ?? {}
}

/**
 * 密钥格式校验。
 *
 * 规则抄自 dsh：trim 后非空，且每个字符都在可打印 ASCII 范围内
 * （`[\x21-\x7E]`，即 HTTP 头值能承载的范围）。
 * 另外拒绝整行粘贴的 `NAME=value` 和首尾成对引号 —— 那是从 .env 里复制来的典型误操作。
 */
export function validateApiKey(raw: string): { ok: boolean; error?: string } {
  const v = raw.trim()
  if (!v) return { ok: false, error: '不能只填空格' }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) return { ok: false, error: '看起来是从 .env 里整行复制来的，只填 = 右边的值' }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return { ok: false, error: '两头不要带引号' }
  }
  if (!/^[\x21-\x7E]+$/.test(v)) return { ok: false, error: '只能包含可见的 ASCII 字符（不能有空格或中文）' }
  return { ok: true }
}

/**
 * 改一个配置字段（API 地址、模型列表……）。
 *
 * ★ 必须用**路径 op**，不能用整段替换。dsh 的注释把原因写得很清楚：
 *
 *   「配置界面拿到的是**脱敏后**的 descriptor —— 它按构造就不包含 role('secret') 的字段。
 *     这样的调用者可以指名它要改的那个字段，而不必重述整段；
 *     **从脱敏文档重建的整段 replace 会静默删掉每一个没被回传的密钥。**」
 *
 * 所以只发 `{op:'set', path:[...], value}`，一个字段一条。
 */
export async function mutateSetting(
  c: DshClient,
  ns: string,
  ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>,
): Promise<{ ok: boolean; error?: string }> {
  const r = await c.call('settings.mutate', { ns, ops })
  return r.ok ? { ok: true } : { ok: false, error: r.error.message }
}

/** 写一个字段 */
export function setSetting(
  c: DshClient,
  ns: string,
  path: string[],
  value: unknown,
): Promise<{ ok: boolean; error?: string }> {
  return mutateSetting(c, ns, [{ op: 'set', path, value }])
}

/** 清一个字段（恢复继承值） */
export function unsetSetting(c: DshClient, ns: string, path: string[]): Promise<{ ok: boolean; error?: string }> {
  return mutateSetting(c, ns, [{ op: 'unset', path }])
}

export interface ProviderDetail {
  /** API 地址（没有就是空，表示用 dsh 内置的默认） */
  baseURL: string
  /** 凭据引用名 */
  apiKeyEnv: string
  /** 显示名称（自定义路由才有） */
  displayName: string
  models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number }>
}

/**
 * 读一个供应商当前的配置详情。
 *
 * 数据源是 `settings.describe` —— 它给的是**继承后的生效值**（用户层覆盖 + 内置目录兜底），
 * 所以内置供应商也能读到它的默认 API 地址。
 */
export async function readProviderDetail(c: DshClient, p: ProviderEntry): Promise<ProviderDetail> {
  const empty: ProviderDetail = { baseURL: '', apiKeyEnv: '', displayName: '', models: [] }
  try {
    const d = await c.value<{ namespaces?: Array<{ ns: string; value?: unknown }> }>('settings.describe', {})
    const ns = d?.namespaces?.find((n) => n.ns === p.settingsNs)
    let node: unknown = ns?.value
    for (const seg of p.settingsPath ?? []) {
      if (node && typeof node === 'object') node = (node as Record<string, unknown>)[String(seg)]
    }
    if (!node || typeof node !== 'object') return empty
    const o = node as Record<string, unknown>
    const models = Array.isArray(o.models)
      ? (o.models as Array<Record<string, unknown>>).map((m) => ({
          id: String(m.id ?? ''),
          name: String(m.name ?? m.id ?? ''),
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
        }))
      : []
    return {
      baseURL: typeof o.baseURL === 'string' ? o.baseURL : '',
      apiKeyEnv: typeof o.apiKeyEnv === 'string' ? o.apiKeyEnv : '',
      displayName: typeof o.displayName === 'string' ? o.displayName : '',
      models,
    }
  } catch {
    return empty
  }
}

/** 写入密钥。只在这一个方向上传值，绝不回读。 */
export async function setCredential(c: DshClient, ref: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const r = await c.call('credentials.set', { ref, value })
  return r.ok ? { ok: true } : { ok: false, error: r.error.message }
}