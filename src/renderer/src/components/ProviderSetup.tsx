import { useEffect, useMemo, useState } from 'react'
import type { DiscoveredModelView, ProviderEntryView } from '../../../shared/types'

/**
 * 模型供应商配置。
 *
 * 设计要点：
 *
 *   ① **不自己造配置格式** —— 读写都走 dsh 自己的接口（`llm.providers` /
 *      `credentials.set` / `llm.discoverModels`）。密钥永远不进 settings.yaml，
 *      而是经凭据库由路由的 `<ROUTE>_API_KEY` 引用。
 *
 *   ② **用户只需要填密钥** —— 供应商从内置目录里选（38 个），API 地址由 dsh
 *      自己的 profile 决定，用户不用抄 URL。
 *
 *   ③ **模型能自动拉取** —— 填完密钥直接问供应商端点要模型列表，
 *      用户不用手抄模型 id（那是新人最容易抄错的一步）。
 *
 *   ④ **搜索** —— 38 个供应商靠滚动找不到，尤其是 `moonshotai` / `minimax-cn`
 *      这种名字。
 */
export function ProviderSetup({
  onDone,
}: {
  /** 配好之后通知外面重新探活 */
  onDone: () => void
}) {
  const [all, setAll] = useState<ProviderEntryView[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<ProviderEntryView | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [models, setModels] = useState<DiscoveredModelView[]>([])

  useEffect(() => {
    void window.bubble.providerList().then((l) => {
      // 已启用的排在前面 —— 那是用户当前真正在用的
      setAll([...l].sort((a, b) => Number(b.active) - Number(a.active)))
    })
  }, [])

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return all.slice(0, 40)
    return all.filter((p) => p.provider.toLowerCase().includes(k) || p.displayName.toLowerCase().includes(k)).slice(0, 40)
  }, [all, q])

  const save = async (): Promise<void> => {
    if (!sel) return
    setBusy('正在保存密钥…')
    setMsg('')
    setModels([])
    const r = await window.bubble.providerSetKey(sel, key)
    if (!r.ok) { setBusy(''); setMsg(r.error ?? '保存失败'); return }
    setBusy('密钥已保存，正在问供应商要模型列表…')
    const d = await window.bubble.providerDiscover(sel.settingsNs, sel.provider)
    setBusy('')
    if (d.error) {
      setMsg('密钥已保存。模型列表没拉到：' + d.error + '（不影响使用，模型由 dsh 的目录兜底）')
      return
    }
    setModels(d.models)
    setMsg('搞定 —— 密钥已保存，并且从这个供应商拉到了 ' + d.models.length + ' 个模型。')
    onDone()
  }

  return (
    <div className="dm-prov">
      {!sel ? (
        <>
          <p className="dm-sub">选一个模型供应商，只需要填它的 API Key。</p>
          <input
            className="dm-input"
            style={{ width: '100%', marginBottom: 8 }}
            placeholder={all.length ? '搜索供应商…（共 ' + all.length + ' 个）' : '正在读取供应商目录…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="dm-provlist">
            {filtered.map((p) => (
              <div key={p.provider} className="dm-provitem" onClick={() => { setSel(p); setKey(''); setMsg(models ? '' : '') }}>
                <b>{p.displayName}</b>
                {p.active ? <span className="dm-tag on">当前使用</span> : null}
                {p.declared ? <span className="dm-tag">自定义</span> : null}
                <small>{p.provider}</small>
              </div>
            ))}
            {all.length > 0 && filtered.length === 0 ? <div className="dm-note">没找到匹配的供应商</div> : null}
          </div>
        </>
      ) : (
        <>
          <div className="dm-selrow">
            <b>{sel.displayName}</b>
            <span className="dm-note">{sel.provider}</span>
            <span className="dm-tag" style={{ cursor: 'pointer' }} onClick={() => { setSel(null); setMsg(''); setModels([]) }}>换一个</span>
          </div>
          <div className="dm-keyrow">
            <input
              className="dm-input"
              type="password"
              placeholder={sel.provider === 'deepseek-official' ? '填 DeepSeek 的 API Key（sk-…）' : '填这个供应商的 API Key'}
              value={key}
              onChange={(e) => { setKey(e.target.value); setMsg('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
            />
            <button className="dm-pri" disabled={busy !== '' || key.trim().length < 8} onClick={() => void save()}>
              保存
            </button>
          </div>
          {busy ? <p className="dm-note">{busy}</p> : null}
          {msg ? <p className="dm-note" style={{ color: msg.startsWith('搞定') ? '#7ee0a0' : '#ffb3b3' }}>{msg}</p> : null}
          {models.length ? (
            <details className="dm-more">
              <summary>看看拉到的 {models.length} 个模型</summary>
              <div className="dm-note">{models.map((m) => m.name || m.id).join(' · ')}</div>
            </details>
          ) : null}
        </>
      )}
    </div>
  )
}
