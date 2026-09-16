import { useEffect, useMemo, useState } from 'react'
import type { ProviderDetailView, ProviderEntryView } from '../../../shared/types'

/**
 * 设置 → 模型管理。
 *
 * 管三样东西：供应商、API 地址、API Key。
 *
 * 三条硬约束（都是 dsh 定的，不是我挑的）：
 *
 *   ① **密钥读不回来。** `credentials.get/read/reveal` 都不存在 —— 密钥是只写的。
 *      所以「显示明文」只能对**本次输入过的**值生效（存在气泡内存里）；
 *      重开气泡之后，界面只能告诉你「已配置」，没法把原文还给你。
 *      这是 dsh 的安全设计，不是我偷懒 —— 我把这件事在界面上写清楚，
 *      而不是给一个点了没反应的按钮。
 *
 *   ② **改字段必须走路径 op。** dsh 的注释写明：配置界面拿到的是脱敏文档，
 *      「从脱敏文档重建的整段 replace 会静默删掉每一个没被回传的密钥」。
 *      所以这里一次只 set 一个字段。
 *
 *   ③ **凭据名不能硬推导。** 内置的 deepseek-official 用的是 DEEPSEEK_API_KEY，
 *      而不是 DEEPSEEK_OFFICIAL_API_KEY。得问 dsh 的 apiKeyEnv。
 */

export function ModelSettings() {
  const [all, setAll] = useState<ProviderEntryView[]>([])
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState('')
  const [detail, setDetail] = useState<ProviderDetailView | null>(null)
  const [keyState, setKeyState] = useState<{ configured: boolean; writable: boolean } | null>(null)
  /** 本次会话里输入过的密钥原文 —— 只有这些能被「显示」*/
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseDraft, setBaseDraft] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<ProviderDetailView['models']>([])

  useEffect(() => {
    void window.bubble.providerList().then((l) => setAll([...l].sort((a, b) => Number(b.active) - Number(a.active) || a.provider.localeCompare(b.provider))))
  }, [])

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return all
    return all.filter((p) => p.provider.toLowerCase().includes(k) || p.displayName.toLowerCase().includes(k))
  }, [all, q])

  const open = async (p: ProviderEntryView): Promise<void> => {
    if (openId === p.provider) { setOpenId(''); return }
    setOpenId(p.provider)
    setMsg(''); setReveal(false); setDraft(''); setModels([])
    const [d, ks] = await Promise.all([window.bubble.providerDetail(p), window.bubble.providerKeyState(p)])
    setDetail(d)
    setBaseDraft(d.baseURL)
    setKeyState(ks)
  }

  const saveKey = async (p: ProviderEntryView): Promise<void> => {
    setBusy(true); setMsg('')
    const r = await window.bubble.providerSetKey(p, draft)
    if (!r.ok) { setBusy(false); setMsg(r.error ?? '保存失败'); return }
    setTyped((t) => ({ ...t, [p.provider]: draft.trim() }))
    setKeyState({ configured: true, writable: true })
    setDraft('')
    setMsg('密钥已保存。正在问这个供应商要模型列表…')
    const d = await window.bubble.providerDiscover(p.settingsNs, p.provider)
    setBusy(false)
    if (d.error) { setMsg('密钥已保存。（模型列表没拉到：' + d.error + '）'); return }
    setModels(d.models)
    setMsg('搞定 —— 从这家拉到了 ' + d.models.length + ' 个模型。')
  }

  const saveBase = async (p: ProviderEntryView): Promise<void> => {
    // API 地址写在 settingsPath 指向的那一层下面
    const path = [...(p.settingsPath ?? []).map(String), 'baseURL']
    setBusy(true); setMsg('')
    const r = await window.bubble.providerSetField(p.settingsNs, path, baseDraft.trim())
    setBusy(false)
    setMsg(r.ok ? 'API 地址已保存。' : '保存失败：' + (r.error ?? ''))
  }

  return (
    <div className="sect">
      <div className="ttl">模型管理</div>
      <div className="desc" style={{ paddingBottom: 8 }}>
        管理模型供应商、API 地址与密钥。全部写进 dsh 自己的配置里（密钥进凭据库，不进配置文件）。
      </div>

      <input
        className="srename"
        style={{ width: '100%', marginBottom: 8 }}
        placeholder={all.length ? '搜索供应商…（共 ' + all.length + ' 个）' : '正在读取供应商目录…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="ms-list">
        {filtered.map((p) => {
          const isOpen = openId === p.provider
          const shown = typed[p.provider]
          return (
            <div key={p.provider} className={'ms-row' + (isOpen ? ' open' : '')}>
              <div className="ms-head" onClick={() => void open(p)}>
                <span className={'ms-dot' + (p.active ? ' on' : '')} />
                <b>{p.displayName}</b>
                {p.active ? <span className="dm-tag on">当前使用</span> : null}
                {p.declared ? <span className="dm-tag">自定义</span> : null}
                <small>{isOpen ? '收起' : '配置'}</small>
              </div>

              {isOpen ? (
                <div className="ms-body">
                  <div className="ms-field">
                    <label>API 地址</label>
                    <input className="srename" value={baseDraft} placeholder="（用 dsh 内置的默认地址）" onChange={(e) => setBaseDraft(e.target.value)} />
                    <span className="kbd2" onClick={() => void saveBase(p)}>保存</span>
                  </div>

                  <div className="ms-field">
                    <label>API Key</label>
                    {keyState?.configured && !draft ? (
                      <input
                        className="srename"
                        readOnly
                        value={shown && reveal ? shown : '••••••••••••••••'}
                        onFocus={() => setDraft(' ')}
                      />
                    ) : (
                      <input
                        className="srename"
                        type={reveal ? 'text' : 'password'}
                        placeholder="粘贴 API Key"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    )}
                    <span className="kbd2" onClick={() => setReveal((v) => !v)} title={shown ? '显示/隐藏' : 'dsh 不允许读回已保存的密钥'}>{reveal ? '隐藏' : '显示'}</span>
                    <span className="kbd2" onClick={() => void saveKey(p)}>{busy ? '…' : '保存'}</span>
                  </div>

                  <div className="ms-hint">
                    {keyState?.configured ? (
                      shown ? '已配置。明文只对本次输入的值可见。' : '已配置 —— 密钥由 dsh 保管，只写不读，无法在这里还原原文。要换就直接填新的。'
                    ) : (
                      '还没配密钥。凭据名：' + (detail?.apiKeyEnv || '（读取中）')
                    )}
                  </div>

                  {models.length ? (
                    <details className="dm-more">
                      <summary>拉到了 {models.length} 个模型</summary>
                      <div className="ms-hint">{models.map((m) => m.name || m.id).join(' · ')}</div>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {msg ? <div className="ms-hint" style={{ marginTop: 8, color: msg.startsWith('搞定') || msg.includes('已保存') ? '#7ee0a0' : '#ffb3b3' }}>{msg}</div> : null}
    </div>
  )
}
