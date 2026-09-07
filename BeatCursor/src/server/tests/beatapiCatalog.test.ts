/**
 * BeatAPI 目录构建与 provider 同步。
 *
 * 这里保护的都是**坏了不会报错**的行为:
 *   - 文本/媒体分流错了 → 生图模型出现在 Cursor 的模型选择器里,选中必失败
 *   - 端点分流错了 → Claude 走 OpenAI 兼容层,能跑但 thinking 是残的
 *   - 合并策略错了 → 每次刷新把用户拨过的开关悄悄清掉
 *   - 空目录写盘 → 网关一时不可达就把用户的模型全部抹掉
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildCatalogFromPricing, buildCatalogFromTextModels, toProviderModel } from '../beatapi/catalog'
import { syncBeatapiProvider } from '../beatapi/provider'
import { lookupCatalogById, resetCatalogCacheForTests, setCatalogForTests } from '../config/catalogStore'
import { loadProviders, resetProvidersCacheForTests } from '../config/providersStore'

/**
 * ⚠️ 把 ~/.beatcursor 挪到临时目录,否则这个测试会改写开发机上**真实的**
 * providers.json —— 已经踩过一次,而且它看起来像通过了。
 *
 * syncBeatapiProvider 走 updateProviders,后者是**读盘 → 改 → 写盘**的,
 * 完全不看 setProvidersForTests 注入的内存态,所以内存注入拦不住它。
 *
 * 改 HOME 而不是 vi.mock('../config/paths'):setupFiles 已经先把 providersStore
 * 载进模块表了,mock 挂不上去。而 paths.ts 的每个函数都是**调用时**才求值
 * homedir(),所以在 beforeAll 里改环境变量对之后的每一次调用都生效。
 */
const TEST_DIR = mkdtempSync(join(tmpdir(), 'beatcursor-catalog-'))
const REAL_HOME = process.env.HOME

beforeAll(() => {
  process.env.HOME = TEST_DIR
})

afterAll(() => {
  process.env.HOME = REAL_HOME
  rmSync(TEST_DIR, { recursive: true, force: true })
})

/** 网关 `/api/pricing` 的最小切片,字段名与线上一致。 */
const PRICING = {
  auto_groups: ['default', 'codex', 'claude', 'qwen'],
  usable_group: {
    default: '默认分组',
    codex: 'codex文本分组',
    claude: 'claude文本分组',
    qwen: 'qwen文本分组',
  },
  data: [
    {
      model_name: 'gpt-5.6-sol',
      enable_groups: ['codex'],
      supported_endpoint_types: ['openai'],
    },
    {
      model_name: 'claude-opus-5',
      enable_groups: ['claude'],
      supported_endpoint_types: ['anthropic', 'openai'],
    },
    {
      model_name: 'qwen3.8-flash',
      enable_groups: ['qwen'],
      supported_endpoint_types: ['openai'],
    },
    // 生图模型:只挂 default,没有家族分组。
    {
      model_name: 'gemini-3.1-flash-image-preview',
      enable_groups: ['default'],
      supported_endpoint_types: ['openai'],
    },
  ],
}

function seedCatalog() {
  setCatalogForTests([
    {
      providerKey: 'openai',
      providerName: 'OpenAI',
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextLimit: 1_050_000,
      outputLimit: 128_000,
      reasoning: true,
      toolCall: true,
      hasImages: true,
    },
    {
      providerKey: 'anthropic',
      providerName: 'Anthropic',
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      // 快照里这条把 output 抄成了和 context 一样大 —— 正是要被封顶的形状。
      contextLimit: 1_000_000,
      outputLimit: 1_000_000,
      reasoning: true,
      toolCall: true,
      hasImages: true,
    },
  ])
}

/**
 * 把起始状态写进磁盘,不是写进内存。
 *
 * updateProviders 每次都重新读盘 —— 这是它的正确行为 (别的实例可能改过文件),
 * 但也意味着 setProvidersForTests 那条内存注入对它完全无效。
 */
function seedProvidersFile(config: { $schemaVersion: number, providers: unknown[] }) {
  const dir = join(TEST_DIR, '.beatcursor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'providers.json'), `${JSON.stringify(config, null, 2)}\n`)
  resetProvidersCacheForTests()
}

beforeEach(() => {
  resetCatalogCacheForTests()
  resetProvidersCacheForTests()
  seedCatalog()
})

describe('lookupCatalogById', () => {
  beforeEach(() => {
    setCatalogForTests([
      { providerKey: 'a', providerName: 'A', id: 'claude-fable-5', name: 'Claude Fable 5', contextLimit: 1_000_000, outputLimit: 128_000, reasoning: true, toolCall: true, hasImages: true },
      { providerKey: 'b', providerName: 'B', id: 'claude-fable-5', name: 'Claude Fable 5', contextLimit: 1_000_000, outputLimit: 128_000, reasoning: true, toolCall: true, hasImages: true },
      { providerKey: 'c', providerName: 'C', id: 'kimi-k3', name: 'Kimi K3', contextLimit: 262_144, outputLimit: 64_000, reasoning: true, toolCall: true, hasImages: false },
    ])
  })

  it('falls back to the base model when the id carries a point release', () => {
    // 快照登记的是 `claude-fable-5`,我们的 id 是 `claude-fable-5-1`。
    // 只做精确匹配时它落到 200k 的保守默认值,而真值是 1M —— 而且不报错。
    expect(lookupCatalogById('claude-fable-5-1')?.contextLimit).toBe(1_000_000)
  })

  it('prefers an exact hit over the base model', () => {
    expect(lookupCatalogById('kimi-k3')?.id).toBe('kimi-k3')
  })

  it('does not invent a match when the base model is unknown either', () => {
    // 剥完后不存在就该查不到 —— 剥出一个**别的**模型比查不到更糟。
    expect(lookupCatalogById('gpt-6-astra')).toBeNull()
    expect(lookupCatalogById('something-else-9')).toBeNull()
  })

  it('leaves an id without a numeric suffix alone', () => {
    expect(lookupCatalogById('claude-fable')).toBeNull()
  })
})

describe('buildCatalogFromPricing', () => {
  it('keeps only models that belong to a text family', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    const ids = catalog.models.map(m => m.id)
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('qwen3.8-flash')
    // 只挂 default 的生图模型不能进来:它进了模型选择器就是一个必然报错的选项。
    expect(ids).not.toContain('gemini-3.1-flash-image-preview')
  })

  it('routes a model to the anthropic entry only when the gateway says it can', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    const byId = new Map(catalog.models.map(m => [m.id, m]))
    expect(byId.get('claude-opus-5')?.native).toBe('anthropic')
    expect(byId.get('gpt-5.6-sol')?.native).toBe('openai')
  })

  it('carries the family label straight from the gateway', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    expect(catalog.families.get('codex')).toBe('codex文本分组')
    expect(catalog.families.get('default')).toBeUndefined()
  })

  it('falls back to a conservative context when the snapshot has never heard of the model', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    const qwen = catalog.models.find(m => m.id === 'qwen3.8-flash')
    expect(qwen?.contextLimit).toBe(200_000)
  })

  it('caps output tokens so a mis-scraped limit cannot eat the context budget', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    const opus = catalog.models.find(m => m.id === 'claude-opus-5')
    expect(opus?.contextLimit).toBe(1_000_000)
    expect(opus?.maxOutputTokens).toBe(64_000)
  })
})

describe('buildCatalogFromTextModels', () => {
  const ENTRIES = [
    {
      id: 'gpt-5.6-sol',
      family: 'codex',
      family_label: 'codex文本分组',
      endpoints: ['openai'],
      context_length: 400_000,
      max_output_tokens: 32_000,
      capabilities: ['Reasoning', 'Tools', 'Vision'],
    },
    {
      id: 'claude-opus-5',
      family: 'claude',
      family_label: 'claude文本分组',
      endpoints: ['anthropic', 'openai'],
      capabilities: ['Tools'],
    },
  ]

  it('lets the gateway override what the bundled snapshot believes', () => {
    // 快照说 1,050,000;网关说 400,000。以网关为准 —— 运营改完立刻生效,
    // 这正是这条接口存在的理由。
    const model = buildCatalogFromTextModels(ENTRIES).models.find(m => m.id === 'gpt-5.6-sol')
    expect(model?.contextLimit).toBe(400_000)
    expect(model?.maxOutputTokens).toBe(32_000)
  })

  it('falls back to the snapshot when the gateway has not configured a limit', () => {
    // claude-opus-5 那条没带 context_length —— 0/缺失都算"未配置",不是"零 token"。
    const model = buildCatalogFromTextModels(ENTRIES).models.find(m => m.id === 'claude-opus-5')
    expect(model?.contextLimit).toBe(1_000_000)
    expect(model?.maxOutputTokens).toBe(64_000)
  })

  it('still caps a gateway-supplied output limit', () => {
    const [model] = buildCatalogFromTextModels([
      { ...ENTRIES[0], max_output_tokens: 1_000_000 },
    ]).models
    expect(model.maxOutputTokens).toBe(64_000)
  })

  it('reads capabilities from the operator tags rather than guessing', () => {
    const catalog = buildCatalogFromTextModels(ENTRIES)
    const sol = catalog.models.find(m => m.id === 'gpt-5.6-sol')
    expect(sol?.reasoning).toBe(true)
    expect(sol?.images).toBe(true)
    // 只标了 Tools —— 那就是没有推理也没有视觉,别拿快照去覆盖人写的事实。
    const opus = catalog.models.find(m => m.id === 'claude-opus-5')
    expect(opus?.reasoning).toBe(false)
    expect(opus?.images).toBe(false)
  })

  it('routes on the endpoints the gateway reports', () => {
    const catalog = buildCatalogFromTextModels(ENTRIES)
    expect(catalog.models.find(m => m.id === 'claude-opus-5')?.native).toBe('anthropic')
    expect(catalog.models.find(m => m.id === 'gpt-5.6-sol')?.native).toBe('openai')
  })

  it('survives a shape it does not recognise instead of throwing', () => {
    // 剥错信封层拿到的是对象不是数组。返回空目录让上层退回 pricing,
    // 抛出去会把整次刷新变成一条报错。
    const catalog = buildCatalogFromTextModels({ object: 'list' } as never)
    expect(catalog.models).toEqual([])
  })

  it('skips entries with no id or no family', () => {
    const catalog = buildCatalogFromTextModels([
      { id: '', family: 'codex' },
      { id: 'orphan', family: '' },
      ...ENTRIES,
    ])
    expect(catalog.models.map(m => m.id).sort()).toEqual(['claude-opus-5', 'gpt-5.6-sol'])
  })
})

describe('toProviderModel', () => {
  it('gives OpenAI models a reasoning enum and Anthropic models a thinking toggle', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    const byId = new Map(catalog.models.map(m => [m.id, m]))

    const sol = toProviderModel(byId.get('gpt-5.6-sol')!)
    expect(sol.parameters?.reasoning).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(sol.parameters?.effort).toBeUndefined()

    const opus = toProviderModel(byId.get('claude-opus-5')!)
    expect(opus.parameters?.thinking).toBe(true)
    expect(opus.parameters?.effort).toEqual(['low', 'medium', 'high'])
    expect(opus.parameters?.reasoning).toBeUndefined()
  })

  it('keeps apiModel identical to the gateway model id', () => {
    const catalog = buildCatalogFromPricing(PRICING)
    for (const model of catalog.models)
      expect(toProviderModel(model).apiModel).toBe(model.id)
  })
})

describe('syncBeatapiProvider', () => {
  it('splits the catalog across the two managed entries and points each at the right base url', async () => {
    seedProvidersFile({ $schemaVersion: 1, providers: [] })
    await syncBeatapiProvider(buildCatalogFromPricing(PRICING), 'sk-test')

    const config = loadProviders()
    const openai = config.providers.find(p => p.id === 'beatapi')
    const claude = config.providers.find(p => p.id === 'beatapi-claude')

    expect(openai?.type).toBe('openai-chat')
    // openai SDK 往 `${baseURL}/chat/completions` 发 —— 少了 /v1 就是 404。
    expect(openai?.baseUrl).toBe('https://api.beatapi.io/v1')
    expect(openai?.models.map(m => m.id).sort()).toEqual(['gpt-5.6-sol', 'qwen3.8-flash'])

    expect(claude?.type).toBe('anthropic')
    // anthropic SDK 自己补 /v1/messages —— 多了 /v1 就是 404。
    expect(claude?.baseUrl).toBe('https://api.beatapi.io')
    expect(claude?.models.map(m => m.id)).toEqual(['claude-opus-5'])

    expect(openai?.auth.value).toBe('sk-test')
    expect(claude?.auth.value).toBe('sk-test')
  })

  it('preserves the switches a user flipped while still refreshing gateway facts', async () => {
    seedProvidersFile({
      $schemaVersion: 1,
      providers: [{
        id: 'beatapi',
        name: 'BeatAPI',
        type: 'openai-chat',
        baseUrl: 'https://api.beatapi.io/v1',
        auth: { kind: 'apiKey', value: 'sk-old' },
        models: [{
          id: 'gpt-5.6-sol',
          apiModel: 'gpt-5.6-sol',
          displayName: 'stale name',
          thinking: true,
          defaultOn: false,
          thinkingLevel: 'high',
          contextTokenLimit: 1,
        }],
      }],
    })

    await syncBeatapiProvider(buildCatalogFromPricing(PRICING), 'sk-new')
    const model = loadProviders().providers.find(p => p.id === 'beatapi')!.models.find(m => m.id === 'gpt-5.6-sol')!

    // 用户拨过的留下
    expect(model.defaultOn).toBe(false)
    expect(model.thinkingLevel).toBe('high')
    // 网关的事实刷新
    expect(model.contextTokenLimit).toBe(1_050_000)
    expect(model.displayName).toBe('GPT-5.6 Sol')
  })

  it('leaves other providers alone and puts the managed ones first', async () => {
    seedProvidersFile({
      $schemaVersion: 1,
      providers: [{
        id: 'my-own',
        name: 'Mine',
        type: 'openai-chat',
        baseUrl: 'https://example.test/v1',
        auth: { kind: 'apiKey', value: 'sk-mine' },
        models: [],
      }],
    })

    await syncBeatapiProvider(buildCatalogFromPricing(PRICING), 'sk-test')
    const ids = loadProviders().providers.map(p => p.id)
    expect(ids).toEqual(['beatapi', 'beatapi-claude', 'my-own'])
  })

  it('writes inside the redirected home, never the real one', async () => {
    // 这条不是在测业务,是在测**测试自己**。少了它,路径重定向哪天失效会以
    // "测试照常通过 + 开发机配置被改写"的形式出现,而那正是最难发现的那种。
    seedProvidersFile({ $schemaVersion: 1, providers: [] })
    await syncBeatapiProvider(buildCatalogFromPricing(PRICING), 'sk-test')
    expect(process.env.HOME).toBe(TEST_DIR)
    expect(existsSync(join(TEST_DIR, '.beatcursor', 'providers.json'))).toBe(true)
  })

  it('refuses to write an empty catalog over a working configuration', async () => {
    seedProvidersFile({ $schemaVersion: 1, providers: [] })
    await syncBeatapiProvider(buildCatalogFromPricing(PRICING), 'sk-test')
    const before = loadProviders().providers.find(p => p.id === 'beatapi')!.models.length

    // 网关短暂不可达时 `/api/pricing` 可能回一个空 data —— 照写会把模型全抹掉。
    const result = await syncBeatapiProvider({ models: [], families: new Map() }, 'sk-test')
    expect(result).toBeNull()
    expect(loadProviders().providers.find(p => p.id === 'beatapi')!.models.length).toBe(before)
  })
})
