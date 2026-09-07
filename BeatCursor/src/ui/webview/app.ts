/**
 * Alpine.js store — webview 客户端全部逻辑
 *
 * 替代原先 panel-provider.ts 内的 640 行内联 JS。
 * Alpine 响应式代理自动追踪 mutation → DOM 更新, 无需手动 render() / rebind。
 */
import type { Alpine as AlpineType } from 'alpinejs'

declare function acquireVsCodeApi(): { postMessage: (msg: any) => void, getState: () => any, setState: (s: any) => void }

// acquireVsCodeApi 只能调用一次
const vscode = acquireVsCodeApi()

// debounce timer for catalog search
let acTimer: ReturnType<typeof setTimeout> | null = null

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const v = value[key]
    if (v !== undefined)
      out[key] = canonicalValue(v)
  }
  return out
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonicalValue)
  if (value && typeof value === 'object')
    return sortedRecord(value as Record<string, unknown>)
  return value
}

function canonicalProvider(provider: any): any {
  if (!provider)
    return {}
  const headers = provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)
    ? sortedRecord(provider.headers)
    : undefined
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl ?? '',
    auth: canonicalValue(provider.auth ?? { kind: 'apiKey', value: '' }),
    models: canonicalValue(Array.isArray(provider.models) ? provider.models : []),
    ...(provider.proxyUrl ? { proxyUrl: provider.proxyUrl } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function providersEqual(a: any, b: any): boolean {
  return stableStringify(canonicalProvider(a)) === stableStringify(canonicalProvider(b))
}

export function initApp(Alpine: AlpineType) {
  // Alpine store 内 this 指向 proxy 对象, TS 无法推断 — 用 any 绕过
  const store: any = {
    // ── 来自 extension 推送 ──
    state: null as any,

    // ── 本地 UI 状态 ──
    drafts: {} as Record<string, any>,
    expanded: {} as Record<string, boolean>,
    modelExpanded: {} as Record<string, Record<string, boolean>>,
    headersInvalid: {} as Record<string, boolean>,
    remoteModels: {} as Record<string, { loading: boolean, models?: any[], error?: string }>,
    saveSnapshots: {} as Record<string, { targetIds: string[], snapshots: Record<string, any> }>,
    savingProviders: {} as Record<string, boolean>,

    // ── BeatAPI 账号 ──
    // 余额按需拉,不跟着 state 走 —— state 在文件监听下刷得很频繁,跟着走会把
    // 余额接口打成心跳。null = 还没拉过 / 拉失败。
    beatapiBalance: null as string | null,
    beatapiBalanceLoading: false,

    // ── 模型广场 ──
    // 目录是**匿名**数据,没登录也该是满的 —— 空面板不会让人想登录,
    // 看得见价格的模型列表才会。
    plaza: [] as any[],
    plazaQuery: '',
    plazaLoading: true,
    plazaCollapsed: {} as Record<string, boolean>,
    plazaOpen: {} as Record<string, boolean>,

    // ── 使用日志 ──
    usage: null as any,
    usageLoading: false,

    /**
     * 只含**文本模型**的用量行 —— 同样是算好放着的数据,不是 getter。
     *
     * 两个原因不能在 `x-for` 里现 filter:一是每次求值新建数组会让 Alpine
     * 反复重建行(见 plazaGroups 上的说明);二是这里要的不只是过滤,
     * 还要按只剩文本之后的口径重算合计 —— 账号总额里含生图/视频,
     * 直接显示会和列出来的行对不上。
     */
    usageRows: [] as any[],
    usageTextSpend: 0,
    usageTextCalls: 0,

    /**
     * 广场分组 —— **算好放着的数据,不是 getter**。
     *
     * ⚠️ 写成 getter 会坏,而且坏得不像 bug:每次求值都新建数组,`x-for` 拿到的
     * 引用每次都不同,于是它反复销毁重建行元素 —— 行在 DOM 里、`display:block`、
     * 高度 0、`x-show` 停在初始的隐藏态,看起来就是"这个家族是空的"。
     * 控制台没有任何报错。
     *
     * 所以只在**输入真的变了**的时候重算一次:目录到了,或搜索词改了。
     */
    plazaGroups: [] as Array<{ family: string, label: string, models: any[] }>,
    plazaTotal: 0,

    /**
     * 未登录那张介绍页用的几个数 —— 全部来自目录本身,不写死。
     *
     * 写死的卖点会烂:模型加到 35 个、折扣调过一轮之后,页面还在说 30 个和
     * 六折,而**没有人会记得回来改它**。目录是匿名可取的,所以未登录也有数。
     */
    plazaFamilyCount: 0,
    /** 折扣区间,存成"打几折"(0.4 = 四折)。0 表示还没数据。 */
    plazaDiscountBest: 0,
    plazaDiscountWorst: 0,

    /**
     * 从 `/v1/usage` 的按模型分解里挑出文本那一类。
     *
     * 这个编辑器客户端只调文本模型,生图/视频是同一个账号在别处花的钱 ——
     * 混在一起会让人以为插件在偷偷生成图片。合计也按文本重算,
     * 保证顶上那行数字和底下列出的行是同一笔账。
     */
    rebuildUsage() {
      // 过滤与合计都在 account.ts 算好了 —— 这里只负责把它落成稳定引用。
      // 老网关不返回 text 字段,兜底成空,面板显示 "No text usage yet"。
      const text = this.usage?.text ?? { rows: [], spend: 0, calls: 0 }
      this.usageRows = (text.rows ?? []).slice(0, 8)
      this.usageTextSpend = Number(text.spend) || 0
      this.usageTextCalls = Number(text.calls) || 0
    },

    rebuildPlaza() {
      const q = this.plazaQuery.trim().toLowerCase()
      const matched = q
        ? this.plaza.filter((m: any) =>
            m.id.toLowerCase().includes(q)
            || (m.displayName || '').toLowerCase().includes(q)
            || (m.familyLabel || '').toLowerCase().includes(q),
          )
        : this.plaza

      // 顺序跟着目录走 —— 网关已经排过,再排一次只会两边不一致。
      const groups: Array<{ family: string, label: string, models: any[] }> = []
      const index: Record<string, number> = {}
      for (const m of matched) {
        if (index[m.family] === undefined) {
          index[m.family] = groups.length
          groups.push({ family: m.family, label: this.fmtFamily(m.familyLabel, m.family), models: [] })
        }
        groups[index[m.family]].models.push(m)
      }
      this.plazaGroups = groups
      this.plazaTotal = matched.length

      // 这几个统计要基于**全量目录**,不是搜索结果 —— 介绍页说的是"我们有什么",
      // 跟着搜索框变会让它在打字时一路跳数字。
      const all = this.plaza as any[]
      const discounts = all.map(m => Number(m.discount) || 0).filter(d => d > 0 && d < 1)
      this.plazaFamilyCount = new Set(all.map(m => m.family)).size
      this.plazaDiscountBest = discounts.length ? Math.min(...discounts) : 0
      this.plazaDiscountWorst = discounts.length ? Math.max(...discounts) : 0
    },

    /** 折扣区间说成 "30–60% off";只有一档时说单个数。 */
    fmtDiscountRange(): string {
      const best = this.plazaDiscountBest
      const worst = this.plazaDiscountWorst
      if (!best)
        return ''
      const off = (d: number) => Math.round((1 - d) * 100)
      return off(worst) === off(best) ? `${off(best)}% off` : `${off(worst)}–${off(best)}% off`
    },

    /**
     * 默认全部折叠 —— 三十个模型摊开是一堵墙,而用户一次只关心一个家族。
     * 搜索时**不**折叠:搜出来的东西藏起来等于没搜。
     */
    collapseAllFamilies() {
      const next: Record<string, boolean> = {}
      for (const g of this.plazaGroups)
        next[g.family] = true
      this.plazaCollapsed = next
    },

    onPlazaQuery() {
      this.rebuildPlaza()
      // 有搜索词就展开,清空搜索词就收回去。
      if (this.plazaQuery.trim())
        this.plazaCollapsed = {}
      else
        this.collapseAllFamilies()
    },

    togglePlazaFamily(family: string) {
      this.plazaCollapsed = { ...this.plazaCollapsed, [family]: !this.plazaCollapsed[family] }
    },

    togglePlazaModel(id: string) {
      this.plazaOpen = { ...this.plazaOpen, [id]: !this.plazaOpen[id] }
    },

    /**
     * 家族标题。网关的标签是「codex文本分组」这种,后缀在这里是噪音 ——
     * 一列英文模型名上面顶一个「XX文本分组」读起来不像同一个东西。
     * 只去后缀,不改运营起的名字本身。
     */
    fmtFamily(label: string, family: string): string {
      const trimmed = (label || family).replace(/文本分组$|分组$/u, '').trim()
      return trimmed || family
    },

    /**
     * 折扣角标。0.5 → 「5折」。
     *
     * 用「几折」而不是「-50%」:魔尊这边的读者对折扣的直觉是前者,
     * 而且 0.72 这种在「-28%」下要心算,写成「7.2折」一眼就懂。
     */
    fmtDiscount(ratio: number): string {
      if (!(ratio > 0) || ratio >= 1)
        return ''
      const tenths = ratio * 10
      return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}折`
    },

    /** 划掉的原价 = 我们的价 ÷ 折扣系数。只有一个数是真的,另一个永远由它推。 */
    fmtList(m: any): string {
      if (!(m.inputUsdPerMillion > 0) || !(m.discount > 0))
        return ''
      return `$${(m.inputUsdPerMillion / m.discount).toFixed(2)}`
    },

    /** 起价一行。网关没给价就说"—",不要显示 $0.00 —— 那读起来是免费。 */
    fmtPrice(m: any): string {
      if (!(m.inputUsdPerMillion > 0))
        return '—'
      return `$${m.inputUsdPerMillion.toFixed(2)}`
    },

    refreshBeatapi() {
      this.beatapiBalanceLoading = true
      this.plazaLoading = true
      this.usageLoading = true
      this.post('beatapiRefresh')
    },

    // ── Web Tools Config ──
    webToolsOpen: false,
    webToolsTab: 'search' as 'search' | 'fetch',
    webTools: null as any,

    isSearchProviderEnabled(type: string): boolean {
      return this.webTools?.search?.providers?.find((p: any) => p.type === type)?.enabled ?? false
    },
    getSearchProviderKey(type: string): string {
      return this.webTools?.search?.providers?.find((p: any) => p.type === type)?.apiKey ?? ''
    },
    toggleSearchProvider(type: string, enabled: boolean) {
      if (!this.webTools?.search)
        return
      const p = this.webTools.search.providers.find((x: any) => x.type === type)
      if (p)
        p.enabled = enabled
    },
    setSearchProviderKey(type: string, key: string) {
      if (!this.webTools?.search)
        return
      const p = this.webTools.search.providers.find((x: any) => x.type === type)
      if (p)
        p.apiKey = key
    },
    setSearchOption(key: string, value: any) {
      if (this.webTools?.search)
        (this.webTools.search as any)[key] = value
    },
    setFetchProvider(provider: string) {
      if (this.webTools)
        this.webTools.fetch.provider = provider
    },
    setFetchKey(provider: string, key: string, value: string) {
      if (!this.webTools)
        return
      if (!this.webTools.fetch[provider])
        this.webTools.fetch[provider] = {}
      this.webTools.fetch[provider][key] = value
    },
    saveWebTools() {
      if (!this.webTools)
        return
      this.post('saveWebTools', { config: JSON.parse(JSON.stringify(this.webTools)) })
      this.webToolsOpen = false
      this.toast('Web tools config saved', 'info')
    },

    // ── Toast ──
    toasts: [] as Array<{ id: number, text: string, level: string }>,
    _toastId: 0,

    toast(text: string, level: 'error' | 'warn' | 'info' = 'info', durationMs = 4000) {
      const id = ++this._toastId
      this.toasts = [...this.toasts, { id, text, level }]
      if (durationMs > 0)
        setTimeout(() => this.dismissToast(id), durationMs)
    },

    dismissToast(id: number) {
      this.toasts = this.toasts.filter((t: any) => t.id !== id)
    },

    // ── Autocomplete ──
    ac: null as { pid: string, mid: string, results: any[], selected: number, reqId: number } | null,
    acReqId: 0,

    // ── 派生 ──
    get providers(): any[] {
      if (!this.state)
        return []
      const base: any[] = this.state.providers || []
      const seen = new Set<string>()
      const out: any[] = []
      for (const p of base) {
        seen.add(p.id)
        out.push(this.drafts[p.id] ?? p)
      }
      // 新建但尚未保存的
      for (const [id, draft] of Object.entries(this.drafts)) {
        if (!seen.has(id))
          out.push(draft)
      }
      return out
    },

    get serverLabel(): string {
      const s = this.state
      if (!s)
        return ''
      if (s.server === 'local')
        return `Running on :${s.port} (this instance)`
      if (s.server === 'remote')
        return `Running on :${s.port} (another instance)`
      if (s.serverIssue === 'port_occupied')
        return `Port :${s.port} occupied by another process`
      return 'Offline'
    },

    // ── Draft 管理 ──
    baseProvider(pid: string): any {
      return (this.state?.providers || []).find((p: any) => p.id === pid)
    },

    getProviderView(pid: string): any {
      return this.drafts[pid] || this.baseProvider(pid) || {}
    },

    getModel(pid: string, mid: string): any {
      const d = this.getProviderView(pid)
      return (d.models || []).find((x: any) => x.id === mid)
    },

    /** 兼容模板旧命名：只读，不创建 draft。写操作必须调用 ensureDraft。 */
    getDraft(pid: string): any {
      return this.getProviderView(pid)
    },

    ensureDraft(pid: string): any {
      if (!this.drafts[pid]) {
        const base = this.baseProvider(pid)
        if (base)
          this.drafts[pid] = clone(base)
        else
          return {}
      }
      return this.drafts[pid]
    },

    getDraftOrOriginal(pid: string): any {
      return this.getProviderView(pid)
    },

    isDirty(pid: string): boolean {
      const draft = this.drafts[pid]
      if (!draft)
        return false
      const base = this.baseProvider(pid)
      if (!base)
        return true // new, not saved
      return !providersEqual(base, draft)
    },

    // ── 校验 ──
    validate(pid: string) {
      const p = this.getDraft(pid)
      const all = this.providers
      const errors: Record<string, string> = {}

      if (!p.name?.trim())
        errors.name = 'Name is required'
      if (!['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(p.type))
        errors.type = 'Invalid type'
      if (p.baseUrl?.trim()) {
        try {
          void new URL(p.baseUrl.trim())
        }
        catch {
          errors.baseUrl = 'Invalid URL'
        }
      }
      if (!p.auth?.value?.trim())
        errors.authValue = 'Auth value is required'
      // Anthropic 允许 apiKey / token 两种; 其他 provider 只允许 apiKey
      if (p.type === 'anthropic') {
        if (!['apiKey', 'token'].includes(p.auth?.kind))
          errors.authKind = 'Invalid auth kind'
      }
      else if (p.auth?.kind !== 'apiKey') {
        errors.authKind = `${p.type} only supports apiKey`
      }

      // name 唯一
      const dupName = all.filter((x: any) => (x.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase()).length > 1
      if (dupName)
        errors.name = 'Duplicate provider name'

      // model 校验
      const modelErrors: Record<string, Record<string, string>> = {}
      const modelIds = new Set<string>()
      const OPTIONAL_NUM_FIELDS = ['thinkingBudgetTokens']
      for (const m of p.models || []) {
        const me: Record<string, string> = {}
        if (!m.apiModel?.trim())
          me.apiModel = 'API model is required'
        if (!m.displayName?.trim())
          me.displayName = 'Display name is required'
        if (modelIds.has(m.id))
          me.id = 'Duplicate model id'
        modelIds.add(m.id)
        // contextTokenLimit 必填 — 影响 Cursor UI 上下文进度条
        if (m.contextTokenLimit === undefined || m.contextTokenLimit === null || m.contextTokenLimit === '') {
          me.contextTokenLimit = 'Context token limit is required'
        }
        else if (!Number.isFinite(Number(m.contextTokenLimit)) || Number(m.contextTokenLimit) <= 0 || !Number.isInteger(Number(m.contextTokenLimit))) {
          me.contextTokenLimit = 'Must be a positive integer'
        }
        // maxOutputTokens — noMaxTokens 开启时跳过必填校验
        if (!m.noMaxTokens) {
          if (m.maxOutputTokens === undefined || m.maxOutputTokens === null || m.maxOutputTokens === '') {
            me.maxOutputTokens = 'Max output tokens is required'
          }
          else if (!Number.isFinite(Number(m.maxOutputTokens)) || Number(m.maxOutputTokens) <= 0 || !Number.isInteger(Number(m.maxOutputTokens))) {
            me.maxOutputTokens = 'Must be a positive integer'
          }
        }
        for (const f of OPTIONAL_NUM_FIELDS) {
          const v = m[f]
          if (v === undefined || v === null || v === '')
            continue
          if (!Number.isFinite(Number(v)) || Number(v) < 0 || !Number.isInteger(Number(v))) {
            me[f] = 'Must be a non-negative integer'
          }
        }
        // Budget 模式校验: thinking=true + 无 level → budget 必填, ≥1024, < maxOutputTokens
        if (m.thinking && !m.thinkingLevel) {
          const b = m.thinkingBudgetTokens
          const maxOut = Number(m.maxOutputTokens) || 0
          if (b === undefined || b === null || b === '')
            me.thinkingBudgetTokens = 'Required — enter budget tokens'
          else if (Number(b) < 1024)
            me.thinkingBudgetTokens = 'Min 1024'
          else if (maxOut > 0 && Number(b) >= maxOut)
            me.thinkingBudgetTokens = `Must be < Max Output Tokens (${maxOut})`
          else if (maxOut === 0)
            me.thinkingBudgetTokens = 'Set Max Output Tokens first'
        }
        if (Object.keys(me).length > 0)
          modelErrors[m.id] = me
      }

      return { errors, modelErrors, ok: Object.keys(errors).length === 0 && Object.keys(modelErrors).length === 0 }
    },

    // ── UI 操作 ──
    toggleExpand(pid: string) {
      this.expanded[pid] = !this.expanded[pid]
    },

    toggleModelExpand(pid: string, mid: string) {
      if (!this.modelExpanded[pid])
        this.modelExpanded[pid] = {}
      this.modelExpanded[pid][mid] = !this.modelExpanded[pid][mid]
    },

    // ── 字段更新 ──
    updateField(pid: string, field: string, value: any) {
      const d = this.ensureDraft(pid)
      if (field === 'auth.kind') {
        d.auth = { ...(d.auth || {}), kind: value }
      }
      else if (field === 'auth.value') {
        d.auth = { ...(d.auth || {}), value }
      }
      else if (field === 'headers') {
        // JSON textarea → parse to object, ignore invalid
        if (typeof value === 'string') {
          const trimmed = value.trim()
          if (!trimmed) {
            delete d.headers
          }
          else {
            try {
              const parsed = JSON.parse(trimmed)
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
                d.headers = parsed
            }
            catch { /* 输入中途不合法 — 不更新 */ }
          }
        }
      }
      else {
        d[field] = value
      }
    },

    formatHeaders(pid: string): string {
      const h = this.getDraft(pid).headers
      if (!h || typeof h !== 'object' || Object.keys(h).length === 0)
        return ''
      return JSON.stringify(h, null, 2)
    },

    updateHeaders(pid: string, raw: string) {
      const trimmed = raw.trim()
      if (!trimmed) {
        this.headersInvalid[pid] = false
        this.updateField(pid, 'headers', '')
        return
      }
      try {
        JSON.parse(trimmed)
        this.headersInvalid[pid] = false
      }
      catch {
        this.headersInvalid[pid] = true
      }
      this.updateField(pid, 'headers', raw)
    },

    /**
     * 切换 provider type 后规范化 auth.kind:
     *   - anthropic 同时支持 apiKey / bearer token, 保留用户选择
     *   - 其他 provider (openai-chat / openai-responses / gemini) 只支持 apiKey,
     *     强制重置为 apiKey 避免旧的 "token" 残留污染
     */
    normalizeAuthKind(pid: string) {
      const d = this.ensureDraft(pid)
      if (d.type !== 'anthropic') {
        d.auth = { ...(d.auth || { value: '' }), kind: 'apiKey' }
      }
    },

    updateModelField(pid: string, mid: string, field: string, value: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      if (field === 'thinkingLevel') {
        if (!value)
          delete m.thinkingLevel
        else m.thinkingLevel = value
      }
      else if (field === 'thinking') {
        m.thinking = !!value
        if (!value) {
          delete m.thinkingLevel
          delete m.thinkingBudgetTokens
        }
        else {
          const pType = d.type
          if (!m.thinkingLevel && !m.thinkingBudgetTokens) {
            if (pType === 'anthropic')
              m.thinkingLevel = 'high'
            else
              m.thinkingLevel = 'medium'
          }
        }
      }
      else {
        m[field] = value
      }

      // QS 联动: thinking/thinkingLevel 变更时自动开启对应 QS 开关
      if (field === 'thinking' || field === 'thinkingLevel') {
        this._syncQsFromDefaults(pid, mid)
      }
    },

    setThinkingMode(pid: string, mid: string, mode: 'level' | 'budget') {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      if (mode === 'level') {
        delete m.thinkingBudgetTokens
        if (!m.thinkingLevel)
          m.thinkingLevel = 'high'
      }
      else {
        delete m.thinkingLevel
      }
    },

    updateModelNumber(pid: string, mid: string, field: string, raw: string) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      if (raw.trim() === '') {
        delete m[field]
        if (field === 'contextTokenLimit')
          delete m.contextTokenLimitForMaxMode
      }
      else {
        const n = Number(raw)
        m[field] = n
        if (field === 'contextTokenLimit')
          m.contextTokenLimitForMaxMode = n
      }

      // QS 联动: budget 模式 (thinkingBudgetTokens) 变更时同样自动开启 QS 开关
      if (field === 'thinkingBudgetTokens')
        this._syncQsFromDefaults(pid, mid)
    },

    // ── Provider / Model 增删 ──
    addProvider() {
      const p = {
        id: uid('provider'),
        name: 'New Provider',
        type: 'anthropic',
        baseUrl: '',
        auth: { kind: 'apiKey', value: '' },
        models: [],
      }
      this.drafts[p.id] = p
      this.expanded[p.id] = true
    },

    addModel(pid: string) {
      const d = this.ensureDraft(pid)
      const m = {
        id: uid('model'),
        apiModel: '',
        displayName: '',
        thinking: false,
        defaultOn: true, // 新建模型默认启用, 避免用户忘记勾选导致客户端看不到
      }
      if (!d.models)
        d.models = []
      d.models.push(m)
      if (!this.modelExpanded[pid])
        this.modelExpanded[pid] = {}
      this.modelExpanded[pid][m.id] = true
    },

    deleteModel(pid: string, mid: string) {
      const d = this.ensureDraft(pid)
      d.models = (d.models || []).filter((x: any) => x.id !== mid)
      if (this.modelExpanded[pid])
        delete this.modelExpanded[pid][mid]
    },

    // ── QuickSwitch auto-link ──

    _syncQsFromDefaults(pid: string, mid: string) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      const pType = d.type as string
      const isOpenAI = pType === 'openai-chat' || pType === 'openai-responses'

      if (m.thinking && m.thinkingLevel) {
        if (!m.parameters)
          m.parameters = {}
        if (isOpenAI) {
          if (!Array.isArray(m.parameters.reasoning))
            m.parameters.reasoning = this._qsLevelsForType(pType)
        }
        else {
          if (m.parameters.thinking !== true)
            m.parameters.thinking = true
          if (!Array.isArray(m.parameters.effort))
            m.parameters.effort = this._qsLevelsForType(pType)
        }
      }
      // budget 模式 (Anthropic/Gemini): QS 没有 budget 轴, 只联动 Thinking Toggle,
      // 运行时由 resolved.thinkingBudgetTokens 兜底
      else if (m.thinking && m.thinkingBudgetTokens && !isOpenAI) {
        if (!m.parameters)
          m.parameters = {}
        if (m.parameters.thinking !== true)
          m.parameters.thinking = true
      }
    },

    _qsLevelsForType(pType: string): string[] {
      if (pType === 'anthropic')
        return ['low', 'medium', 'high', 'xhigh', 'max']
      if (pType === 'gemini')
        return ['minimal', 'low', 'medium', 'high']
      return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    },

    // ── Edit Panel parameters helpers ──

    setEditParam(pid: string, mid: string, key: string, value: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      if (!m.parameters)
        m.parameters = {}
      if (value === undefined || value === false)
        delete (m.parameters as any)[key]
      else
        (m.parameters as any)[key] = value
      if (Object.keys(m.parameters).length === 0)
        delete m.parameters
    },

    toggleEditParamArrayItem(pid: string, mid: string, key: string, item: string, checked: boolean) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters)
        return
      const arr: string[] = (m.parameters as any)[key]
      if (!Array.isArray(arr))
        return
      if (checked && !arr.includes(item))
        arr.push(item)
      else if (!checked)
        (m.parameters as any)[key] = arr.filter((v: string) => v !== item)
    },

    removeEditParamArrayIndex(pid: string, mid: string, key: string, index: number) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters)
        return
      const arr: any[] = (m.parameters as any)[key]
      if (!Array.isArray(arr))
        return
      arr.splice(index, 1)
    },

    addEditParamContextValue(pid: string, mid: string, value: number) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters || !Array.isArray(m.parameters.context))
        return
      if (!value || value <= 0 || !Number.isFinite(value))
        return
      if (!m.parameters.context.includes(value)) {
        m.parameters.context.push(value)
        m.parameters.context.sort((a: number, b: number) => a - b)
      }
    },

    resetProvider(pid: string) {
      delete this.drafts[pid]
      const base = (this.state?.providers || []).find((p: any) => p.id === pid)
      if (!base) {
        delete this.expanded[pid]
        delete this.modelExpanded[pid]
      }
    },

    moveProvider(pid: string, direction: number) {
      const list = [...(this.state?.providers || [])]
      const idx = list.findIndex((p: any) => p.id === pid)
      if (idx < 0)
        return
      const target = idx + direction
      if (target < 0 || target >= list.length)
        return
      const tmp = list[idx]
      list[idx] = list[target]
      list[target] = tmp
      const merged = list.map((p: any) => this.drafts[p.id] ?? p)
      this.post('saveProviders', { providers: JSON.parse(JSON.stringify(merged)) })
    },

    deleteProvider(pid: string) {
      const remaining = (this.state?.providers || []).filter((p: any) => p.id !== pid)
      const merged = remaining.map((p: any) => this.drafts[p.id] ?? p)
      delete this.drafts[pid]
      delete this.expanded[pid]
      delete this.modelExpanded[pid]
      this.post('saveProviders', { providers: JSON.parse(JSON.stringify(merged)) })
    },

    saveProvider(pid: string) {
      try {
        const p = this.getProviderView(pid)
        const v = this.validate(pid)
        if (!v.ok) {
          const providerName = p.name || 'Provider'
          for (const [, msg] of Object.entries(v.errors))
            this.toast(`${providerName}: ${msg}`, 'error', 6000)
          for (const [mid, errs] of Object.entries(v.modelErrors) as [string, Record<string, string>][]) {
            const m = (p.models || []).find((x: any) => x.id === mid)
            const modelLabel = m?.displayName || m?.apiModel || mid
            for (const [, msg] of Object.entries(errs))
              this.toast(`${providerName}: ${modelLabel} — ${msg}`, 'error', 6000)
            this.expanded[p.id] = true
            if (!this.modelExpanded[p.id])
              this.modelExpanded[p.id] = {}
            this.modelExpanded[p.id][mid] = true
          }
          return
        }

        const snapshot = clone(p)
        const baseProviders = [...(this.state?.providers || [])]
        const idx = baseProviders.findIndex((x: any) => x.id === pid)
        const nextProviders = idx >= 0
          ? baseProviders.map((x: any) => x.id === pid ? snapshot : x)
          : [...baseProviders, snapshot]
        const requestId = uid('save')
        this.saveSnapshots[requestId] = { targetIds: [pid], snapshots: { [pid]: snapshot } }
        this.savingProviders[pid] = true
        this.post('saveProviders', {
          requestId,
          targetIds: [pid],
          providers: JSON.parse(JSON.stringify(nextProviders)),
        })
      }
      catch (e) {
        this.toast(`Save error: ${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    },

    // ── Autocomplete ──
    searchCatalog(pid: string, mid: string, query: string) {
      if (acTimer)
        clearTimeout(acTimer)
      const q = query.trim()
      if (q.length < 2 && !this.ac) {
        return
      }
      acTimer = setTimeout(() => {
        const reqId = ++this.acReqId
        this.ac = { pid, mid, results: [], selected: 0, reqId }
        vscode.postMessage({ type: 'searchCatalog', query: q.length >= 2 ? q : '', requestId: reqId })
      }, 120)
    },

    toggleCatalog(pid: string, mid: string, inputEl: HTMLInputElement | null) {
      if (this.ac?.pid === pid && this.ac?.mid === mid) {
        this.ac = null
        return
      }
      const q = (inputEl?.value ?? '').trim()
      const reqId = ++this.acReqId
      this.ac = { pid, mid, results: [], selected: 0, reqId }
      vscode.postMessage({ type: 'searchCatalog', query: q, requestId: reqId })
      inputEl?.focus()
    },

    applyCatalogEntry(pid: string, mid: string, entry: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      // id 保持 addModel 生成的随机值不变 — 作为跨 provider 全局唯一 key
      m.apiModel = entry.id
      if (!m.displayName?.trim())
        m.displayName = entry.name
      if (m.contextTokenLimit === undefined || m.contextTokenLimit === null) {
        m.contextTokenLimit = entry.contextLimit
        m.contextTokenLimitForMaxMode = entry.contextLimit
      }
      if (!m.thinking && entry.reasoning) {
        m.thinking = true
        if (!m.thinkingLevel && !m.thinkingBudgetTokens) {
          const pType = d.type
          m.thinkingLevel = pType === 'anthropic' ? 'high' : 'medium'
        }
      }
      if ((m.maxOutputTokens === undefined || m.maxOutputTokens === null) && entry.outputLimit)
        m.maxOutputTokens = entry.outputLimit
      if (m.supportsAgent === undefined)
        m.supportsAgent = entry.toolCall
      if (m.supportsImages === undefined)
        m.supportsImages = entry.hasImages

      this.ac = null
      // x-effect 在 input 聚焦时不回写 DOM，blur 后又不重跑（m.apiModel 无二次变化）。
      // 因此手动将选中的 entry.id 写入 DOM 再 blur，确保完整 model ID 上屏。
      queueMicrotask(() => {
        if (document.activeElement instanceof HTMLInputElement) {
          document.activeElement.value = m.apiModel || ''
          document.activeElement.blur()
        }
      })
    },

    acNavigate(dir: number) {
      if (!this.ac || !this.ac.results.length)
        return
      this.ac.selected = Math.max(0, Math.min(this.ac.selected + dir, this.ac.results.length - 1))
    },

    acSelect(pid: string, mid: string) {
      if (!this.ac || !this.ac.results.length)
        return
      const entry = this.ac.results[this.ac.selected]
      if (entry)
        this.applyCatalogEntry(pid, mid, entry)
    },

    acClose() {
      this.ac = null
    },

    // ── Remote Models (GET /v1/models) ──
    fetchRemoteModels(pid: string) {
      if (this.remoteModels[pid]?.loading)
        return
      const draft = this.getDraft(pid)
      if (!draft.baseUrl?.trim()) {
        this.toast('Please set Base URL first', 'warn')
        return
      }
      if (!draft.auth?.value?.trim()) {
        this.toast('Please set Auth value first', 'warn')
        return
      }
      this.remoteModels = { ...this.remoteModels, [pid]: { loading: true } }
      this.post('fetchRemoteModels', { pid, draft: JSON.parse(JSON.stringify(draft)) })
    },

    dismissRemoteModels(pid: string) {
      const { [pid]: _, ...rest } = this.remoteModels
      this.remoteModels = rest
    },

    applyRemoteModel(pid: string, modelId: string) {
      this.addModel(pid)
      const d = this.ensureDraft(pid)
      const models = d.models || []
      const lastModel = models[models.length - 1]
      if (lastModel) {
        lastModel.apiModel = modelId
        // 展开新 model 面板
        if (!this.modelExpanded[pid])
          this.modelExpanded[pid] = {}
        this.modelExpanded[pid][lastModel.id] = true
        // 触发 catalog fuzzy search 自动补全
        queueMicrotask(() => this.searchCatalog(pid, lastModel.id, modelId))
      }
    },

    /** apiModel blur — id 保持不变,不再同步覆盖 */
    syncModelId(_pid: string, _mid: string) {
      // id 是 addModel 生成的随机值,作为全局唯一 key,不随 apiModel 变化
    },

    /** 获取单个 model 的校验错误 (供模板使用, 避免长表达式) */
    getModelErrors(pid: string, mid: string): Record<string, string> {
      return this.validate(pid).modelErrors[mid] || {}
    },

    fmtCtx(n: number): string {
      if (n >= 1_000_000) {
        const v = n / 1_000_000
        return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
      }
      if (n >= 1_000)
        return `${Math.round(n / 1_000)}k`
      return String(n)
    },

    // ── 通信 ──
    post(type: string, payload?: any) {
      vscode.postMessage({ type, ...payload })
    },
  }

  Alpine.store('app', store)

  // ── 消息接收 ──
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data
    const s = Alpine.store('app') as any

    if (msg?.type === 'state') {
      s.state = msg.state
      if (msg.state?.webTools)
        s.webTools = clone(msg.state.webTools)
      for (const pid of Object.keys(s.drafts)) {
        const base = (s.state?.providers || []).find((p: any) => p.id === pid)
        if (base && providersEqual(base, s.drafts[pid]))
          delete s.drafts[pid]
      }
    }
    else if (msg?.type === 'saveProvidersResult') {
      if (msg.state) {
        s.state = msg.state
        if (msg.state?.webTools)
          s.webTools = clone(msg.state.webTools)
      }
      const requestId = msg.requestId as string
      const pending = requestId ? s.saveSnapshots[requestId] : null
      const targetIds = pending?.targetIds || msg.targetIds || []
      for (const pid of targetIds)
        delete s.savingProviders[pid]
      if (!msg.ok) {
        s.toast(`Save failed: ${msg.error || 'unknown error'}`, 'error', 6000)
      }
      else {
        for (const pid of targetIds) {
          const sent = pending?.snapshots?.[pid]
          const current = s.drafts[pid]
          const base = (s.state?.providers || []).find((p: any) => p.id === pid)
          if (sent && current && providersEqual(current, sent))
            delete s.drafts[pid]
          else if (sent && !current && base && providersEqual(base, sent))
            delete s.drafts[pid]
          else if (!sent && base && current && providersEqual(base, current))
            delete s.drafts[pid]
        }
        s.toast('Providers saved.', 'info')
      }
      if (requestId)
        delete s.saveSnapshots[requestId]
    }
    else if (msg?.type === 'remoteModelsResult') {
      const pid = msg.pid as string
      if (msg.error) {
        s.remoteModels = { ...s.remoteModels, [pid]: { loading: false, error: msg.error } }
        s.toast(`Fetch models failed: ${msg.error}`, 'error', 6000)
      }
      else {
        s.remoteModels = { ...s.remoteModels, [pid]: { loading: false, models: msg.models || [] } }
      }
    }
    else if (msg?.type === 'catalogResults') {
      if (!s.ac || msg.requestId !== s.ac.reqId)
        return
      s.ac.results = msg.results || []
      s.ac.selected = 0
    }
    else if (msg?.type === 'beatapiBalance') {
      s.beatapiBalanceLoading = false
      s.usageLoading = false
      s.beatapiBalance = typeof msg.balance === 'string' ? msg.balance : null
      s.usage = msg.usage ?? null
      // 派生数据不是响应式的,必须显式重算 —— 见 rebuildUsage 上的说明。
      s.rebuildUsage()
    }
    else if (msg?.type === 'beatapiCatalog') {
      s.plazaLoading = false
      // 只有拿到非空目录才替换 —— 一次失败的刷新不该把已经显示出来的清单清空。
      if (Array.isArray(msg.models) && msg.models.length > 0) {
        s.plaza = msg.models
        // 目录不是响应式派生的,必须显式重算 —— 见 rebuildPlaza 上的说明。
        s.rebuildPlaza()
        s.collapseAllFamilies()
      }
    }
    else if (msg?.type === 'toast') {
      s.toast(msg.text, msg.level || 'info', msg.duration ?? 4000)
    }
  })

  // 通知 extension 就绪
  vscode.postMessage({ type: 'ready' })
}
