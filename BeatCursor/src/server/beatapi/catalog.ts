/**
 * BeatAPI 模型目录 —— 从网关取,不在客户端维护清单。
 *
 * 为什么不写死一张表:网关随时会上下架模型。手写清单的失效方式是**静默**的 ——
 * 新模型不出现、下架的模型还在列表里点了报错,而且两种都不会有人报告。
 * 所以清单只有一个真源:网关的 `/api/pricing`(公开,无需鉴权)。
 *
 * 客户端只补网关**不知道**的那部分:
 *   1. 上下文/输出上限 —— 网关按 token 计价,不关心窗口多大;
 *      从 installer 自带的 models.dev 快照按模型 id 精确 join。
 *   2. 快照也查不到的,退到保守默认值 —— **不猜**。要准数就去网关上填。
 *
 * 端点分流同样是数据驱动的:按 `supported_endpoint_types` 决定进
 * anthropic 原生那条还是 OpenAI 兼容那条,不按模型名前缀猜。
 */
import type { ProviderModel, ThinkingLevel } from '../data/defaults'
import { lookupCatalogById } from '../config/catalogStore'
import { logger } from '../logger'
import { BEATAPI_BASE_URL, BEATAPI_ENDPOINTS } from './constants'

/** `/api/pricing` 里我们用到的字段。其余(计价表达式、倍率)与客户端无关。 */
interface PricingModel {
  model_name?: string
  quota_type?: number
  enable_groups?: string[]
  supported_endpoint_types?: string[]
}

interface PricingResponse {
  data?: PricingModel[]
  auto_groups?: string[]
  usable_group?: Record<string, string>
}

export interface BeatapiModel {
  id: string
  /** 所属文本家族 (codex / claude / gemini / …)。`default` 表示不属于任何家族。 */
  family: string
  /** 家族的中文展示名,直接取网关的 `usable_group`。 */
  familyLabel: string
  /** 是否支持 Anthropic 原生 `/v1/messages`。 */
  native: 'anthropic' | 'openai'
  contextLimit: number
  maxOutputTokens: number
  reasoning: boolean
  images: boolean
  displayName: string
  /** 零售价,美元/百万 token,已按家族折扣算好。0 = 网关没给价。 */
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  /** 家族折扣系数,0.5 = 五折。0 = 无折扣(或网关没给)。 */
  discount: number
}

export interface BeatapiCatalog {
  models: BeatapiModel[]
  /** 家族 id → 中文名,面板分组标题用。 */
  families: Map<string, string>
}

/** 快照与兜底都没有时的保守默认 —— 宁可少报也不要让 Cursor 超发被上游截断。 */
const FALLBACK_CONTEXT = 200000

/**
 * 输出上限的封顶。
 *
 * 快照里有几条把 output 抄成了和 context 一样大 (claude-opus-5 记的是
 * 1000000)。照抄会让 Cursor 按那个数预留预算,挤掉真正能用的上下文。
 * 编码场景没有单轮几十万 token 的输出,封在这里是安全的。
 */
const MAX_OUTPUT_TOKENS = 64000

/** OpenAI 系的 reasoning 档位 —— 网关按 `reasoning_effort` 原样透传。 */
const OPENAI_REASONING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high']

/** Anthropic 系的 effort 档位。 */
const ANTHROPIC_EFFORT_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high']

/**
 * 模型 id → 展示名。
 *
 * 刻意保留原始 id 的形状 (只做大小写和分隔符的美化):用户在文档、控制台日志、
 * 计费明细里看到的都是 id,展示名换个写法只会让人对不上号。
 */
function prettifyModelId(id: string): string {
  return id
    .split(/[-_]/)
    .map(part => (/^\d/.test(part) || /[A-Z]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * 本地兜底的上下文 —— 只在**网关没配置**时才用得上。
 *
 * ⚠️ 这里曾经有一张手写的 `CONTEXT_OVERRIDES`,装着吾对快照查不到的模型的
 * 猜测值。它害过一次:`claude-fable-5-1` 被猜成 200k(真值 1M),而那个猜的数
 * 后来被当成事实写进了网关。
 *
 * 教训是**猜出来的数不该有第二个存放处**。查不到就退到保守默认,让它显示成
 * 一个明显偏小的值;要修就去网关上填真值,那里是唯一的真源。
 */
function resolveLimits(id: string): { context: number, output: number } {
  const entry = lookupCatalogById(id)
  if (entry && entry.contextLimit > 0) {
    return {
      context: entry.contextLimit,
      output: Math.min(entry.outputLimit && entry.outputLimit > 0 ? entry.outputLimit : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    }
  }
  return { context: FALLBACK_CONTEXT, output: MAX_OUTPUT_TOKENS }
}

/**
 * 判定一条计价条目是不是**文本**模型。
 *
 * 判据是"它属于某个文本家族",不是模型名长什么样。网关把生图/视频模型全部只挂
 * 在 `default` 分组下,文本模型则各自有家族分组 —— 所以家族存在与否就是分界线,
 * 而且新增一个视频模型不会误入 Cursor 的模型选择器。
 */
function textFamilyOf(model: PricingModel, autoGroups: Set<string>): string | null {
  for (const group of model.enable_groups ?? []) {
    if (group !== 'default' && autoGroups.has(group))
      return group
  }
  return null
}

export function buildCatalogFromPricing(payload: PricingResponse): BeatapiCatalog {
  const autoGroups = new Set((payload.auto_groups ?? []).filter(g => g !== 'default'))
  const labels = payload.usable_group ?? {}
  const models: BeatapiModel[] = []
  const families = new Map<string, string>()

  for (const entry of payload.data ?? []) {
    const id = entry.model_name?.trim()
    if (!id)
      continue
    const family = textFamilyOf(entry, autoGroups)
    if (!family)
      continue

    const endpoints = entry.supported_endpoint_types ?? []
    const native = endpoints.includes('anthropic') ? 'anthropic' : 'openai'
    const limits = resolveLimits(id)
    const catalogEntry = lookupCatalogById(id)
    const familyLabel = labels[family] ?? family

    families.set(family, familyLabel)
    models.push({
      id,
      family,
      familyLabel,
      native,
      contextLimit: limits.context,
      maxOutputTokens: limits.output,
      // 快照没收录的模型一律按"支持推理"处理:多给一个用户可以关掉的开关,
      // 好过把一个真会推理的模型钉死在无推理模式上。
      reasoning: catalogEntry ? catalogEntry.reasoning : true,
      images: catalogEntry?.hasImages ?? false,
      displayName: catalogEntry?.name?.trim() || prettifyModelId(id),
      // `/api/pricing` 那条退路不带零售价 —— 价格是新接口才有的。
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      discount: 0,
    })
  }

  models.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id))
  return { models, families }
}

/** 把目录条目翻译成宿主的 ProviderModel。 */
export function toProviderModel(model: BeatapiModel): ProviderModel {
  const providerModel: ProviderModel = {
    id: model.id,
    apiModel: model.id,
    displayName: model.displayName,
    // 目录里有的就是能用的 —— 默认全开。不写这个字段会在 byokModelBuilder
    // 里落成 false,表现是模型出现在设置页但开关是灰的,得逐个手点。
    // 用户关掉的不会被这里重新打开:defaultOn 在 USER_OWNED_FIELDS 里,
    // 刷新时按字段级合并保留(见 provider.ts)。
    defaultOn: true,
    thinking: model.reasoning,
    supportsAgent: true,
    supportsImages: model.images,
    supportsCmdK: true,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    contextTokenLimit: model.contextLimit,
    maxOutputTokens: model.maxOutputTokens,
    tooltipMarkdown: `**${model.displayName}**\n\nBeatAPI · ${model.familyLabel}\n\nContext ${formatTokens(model.contextLimit)} · Output ${formatTokens(model.maxOutputTokens)}`,
  }
  if (model.reasoning) {
    providerModel.parameters = model.native === 'anthropic'
      ? { thinking: true, effort: ANTHROPIC_EFFORT_LEVELS }
      : { reasoning: OPENAI_REASONING_LEVELS }
  }
  return providerModel
}

function formatTokens(count: number): string {
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`
  if (count >= 1000)
    return `${Math.round(count / 1000)}K`
  return String(count)
}

/** `/v1/text/models` 的一条。网关权威的那份。 */
interface TextModelEntry {
  id?: string
  family?: string
  family_label?: string
  endpoints?: string[]
  context_length?: number
  max_output_tokens?: number
  input_usd_per_million?: number
  output_usd_per_million?: number
  discount?: number
  capabilities?: string[]
  description?: string
}

/**
 * 用网关的文本目录建目录。
 *
 * 与 `/api/pricing` 那条路的差别只在**上下文从哪来**:这里是网关直接给的数字,
 * 运营在模型管理里改完立刻生效,不用等客户端发版。网关没配(回 0 或不回)时
 * 才退回本地快照 —— 所以两条路的兜底完全一致,不会出现"换了接口窗口就变了"。
 */
export function buildCatalogFromTextModels(entries: TextModelEntry[]): BeatapiCatalog {
  const models: BeatapiModel[] = []
  const families = new Map<string, string>()

  // 拿到的不是数组多半是信封剥错了层。返回空目录而不是抛 —— 上层看到空就退回
  // pricing,那是对的降级;抛出去会把整次刷新变成一条报错。
  if (!Array.isArray(entries))
    return { models, families }

  for (const entry of entries) {
    const id = entry.id?.trim()
    const family = entry.family?.trim()
    if (!id || !family)
      continue

    const endpoints = entry.endpoints ?? []
    const native = endpoints.includes('anthropic') ? 'anthropic' : 'openai'
    const local = resolveLimits(id)
    const catalogEntry = lookupCatalogById(id)
    const familyLabel = entry.family_label?.trim() || family
    const capabilities = entry.capabilities ?? []

    families.set(family, familyLabel)
    models.push({
      id,
      family,
      familyLabel,
      native,
      // 网关给了就用网关的;给 0 或没给都算"未配置",退回本地。
      contextLimit: entry.context_length && entry.context_length > 0 ? entry.context_length : local.context,
      maxOutputTokens: entry.max_output_tokens && entry.max_output_tokens > 0
        ? entry.max_output_tokens
        : local.output,
      // 运营在模型管理里打的能力标签优先于快照的推断 —— 它是人写的事实。
      reasoning: capabilities.length > 0
        ? capabilities.some(tag => /reason|think/i.test(tag))
        : (catalogEntry ? catalogEntry.reasoning : true),
      images: capabilities.length > 0
        ? capabilities.some(tag => /vision|image/i.test(tag))
        : (catalogEntry?.hasImages ?? false),
      displayName: catalogEntry?.name?.trim() || prettifyModelId(id),
      inputUsdPerMillion: entry.input_usd_per_million ?? 0,
      outputUsdPerMillion: entry.output_usd_per_million ?? 0,
      discount: entry.discount ?? 0,
    })
  }

  models.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id))
  return { models, families }
}

/**
 * `/v1/text/models` 的信封。
 *
 * ⚠️ **两层 `data`**:网关把 `{object, data}` 的列表又套进 BeatAPI 的
 * `{data: …}` 信封里,所以模型数组在 `body.data.data`。只剥一层拿到的是那个
 * 列表对象而不是数组 —— 而这里的失败是**静默降级**:取不到就退回
 * `/api/pricing`,目录照样是满的,只是永远拿不到网关给的上下文和价格。
 */
interface TextModelsResponse {
  data?: { data?: TextModelEntry[] } | TextModelEntry[]
}

function textModelEntriesOf(payload: TextModelsResponse | null): TextModelEntry[] {
  const outer = payload?.data
  if (Array.isArray(outer))
    return outer
  return outer?.data ?? []
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok)
    throw new Error(`${url} failed: ${res.status}`)
  return await res.json() as T
}

/**
 * 拉取并构建目录。
 *
 * 先问网关的专用接口,不行再退回 `/api/pricing`。两条路都保留是因为它们**失效
 * 时机不同**:专用接口是新加的,老部署上不存在(404);
 * 而 `/api/pricing` 从一开始就在,少了它连价格页都没了。
 *
 * 失败时抛错而不是返回空目录:空目录会被上层当成"网关一个模型都没有"写进
 * providers.json,把用户已经在用的模型全部抹掉。宁可保留上一次的结果。
 */
export async function fetchCatalog(baseUrl: string = BEATAPI_BASE_URL): Promise<BeatapiCatalog> {
  try {
    const payload = await getJson<TextModelsResponse>(`${baseUrl}${BEATAPI_ENDPOINTS.textModels}`)
    const catalog = buildCatalogFromTextModels(textModelEntriesOf(payload))
    // 接口在、但一条都没回,说明这个部署还没把文本模型标成家族分组 ——
    // 当成"这条路不可用"退回去,而不是当成"没有模型"。
    if (catalog.models.length > 0) {
      logger.info(
        { models: catalog.models.length, families: catalog.families.size, source: 'text/models' },
        '[BeatAPI] model catalog fetched',
      )
      return catalog
    }
    logger.info('[BeatAPI] text catalog empty, falling back to pricing')
  }
  catch (err) {
    logger.info({ err: (err as Error).message }, '[BeatAPI] text catalog unavailable, falling back to pricing')
  }

  const payload = await getJson<PricingResponse>(`${baseUrl}${BEATAPI_ENDPOINTS.pricing}`)
  const catalog = buildCatalogFromPricing(payload)
  logger.info(
    { models: catalog.models.length, families: catalog.families.size, source: 'pricing' },
    '[BeatAPI] model catalog fetched',
  )
  return catalog
}
