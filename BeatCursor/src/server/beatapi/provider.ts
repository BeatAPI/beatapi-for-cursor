/**
 * 把 BeatAPI 目录写进 providers.json。
 *
 * 两条 provider 条目共用一把 key,按模型的原生端点分流 (见 constants.ts)。
 *
 * 同步策略是**字段级合并**,不是整体覆盖:
 *   - 网关新上的模型出现,下架的模型消失 —— 否则用户会在选择器里点到一个
 *     必然报错的模型,而且没有任何提示说它已经没了;
 *   - 上下文/输出上限跟着刷新 —— 这些是网关侧的事实,本地改了也不会生效;
 *   - 用户自己拨过的开关保留 —— 见 USER_OWNED_FIELDS。
 *
 * 整体覆盖会在每次刷新时把用户的选择悄悄清掉,而"我明明关过它"这种问题
 * 几乎没人会报,只会让人觉得面板不稳。
 */
import type { ProviderEntry, ProviderModel, ProvidersConfig } from '../data/defaults'
import type { BeatapiCatalog } from './catalog'
import { updateProviders } from '../config/providersStore'
import { logger } from '../logger'
import { toProviderModel } from './catalog'
import {
  BEATAPI_ANTHROPIC_BASE_URL,
  BEATAPI_CLAUDE_PROVIDER_ID,
  BEATAPI_OPENAI_BASE_URL,
  BEATAPI_PROVIDER_ID,
  BEATAPI_PROVIDER_IDS,
} from './constants'

/**
 * 刷新时保留的字段 —— 面板上用户能直接拨的那些。
 *
 * 只列**用户拨得动**的:contextTokenLimit 之类的不在其中,那是网关的事实,
 * 保留本地值只会让两边分叉。
 */
const USER_OWNED_FIELDS = ['defaultOn', 'thinkingLevel', 'thinkingBudgetTokens', 'fastMode'] as const

function mergeUserChoices(generated: ProviderModel, previous: ProviderModel | undefined): ProviderModel {
  if (!previous)
    return generated
  const merged = { ...generated }
  for (const field of USER_OWNED_FIELDS) {
    const value = previous[field]
    if (value !== undefined)
      (merged as Record<string, unknown>)[field] = value
  }
  return merged
}

function buildEntry(
  id: string,
  name: string,
  type: ProviderEntry['type'],
  baseUrl: string,
  key: string,
  models: ProviderModel[],
  previous: ProviderEntry | undefined,
): ProviderEntry {
  const previousById = new Map((previous?.models ?? []).map(m => [m.id, m]))
  return {
    id,
    name,
    type,
    baseUrl,
    auth: { kind: 'apiKey', value: key },
    models: models.map(m => mergeUserChoices(m, previousById.get(m.id))),
  }
}

/**
 * 用最新目录与 key 重建两条 BeatAPI provider。
 *
 * 目录为空时**什么都不做** —— 空目录几乎一定是网关暂时不可达,照写会把用户
 * 正在用的模型全部抹掉,而恢复要等下一次成功刷新。宁可留着旧的。
 */
export async function syncBeatapiProvider(
  catalog: BeatapiCatalog,
  relayKey: string,
): Promise<ProvidersConfig | null> {
  if (catalog.models.length === 0) {
    logger.warn('[BeatAPI] refusing to sync an empty catalog, keeping existing providers')
    return null
  }

  const openaiModels = catalog.models.filter(m => m.native === 'openai').map(toProviderModel)
  const claudeModels = catalog.models.filter(m => m.native === 'anthropic').map(toProviderModel)

  return updateProviders((draft) => {
    const previousOpenai = draft.providers.find(p => p.id === BEATAPI_PROVIDER_ID)
    const previousClaude = draft.providers.find(p => p.id === BEATAPI_CLAUDE_PROVIDER_ID)

    const rebuilt: ProviderEntry[] = []
    if (openaiModels.length > 0) {
      rebuilt.push(buildEntry(
        BEATAPI_PROVIDER_ID,
        'BeatAPI',
        'openai-chat',
        BEATAPI_OPENAI_BASE_URL,
        relayKey,
        openaiModels,
        previousOpenai,
      ))
    }
    if (claudeModels.length > 0) {
      rebuilt.push(buildEntry(
        BEATAPI_CLAUDE_PROVIDER_ID,
        'BeatAPI · Claude',
        'anthropic',
        BEATAPI_ANTHROPIC_BASE_URL,
        relayKey,
        claudeModels,
        previousClaude,
      ))
    }

    // 托管条目排在最前:BYOK 面板按顺序渲染,内置的应该是打开就看到的第一组。
    const others = draft.providers.filter(p => !BEATAPI_PROVIDER_IDS.includes(p.id))
    draft.providers = [...rebuilt, ...others]
    logger.info(
      { openai: openaiModels.length, claude: claudeModels.length },
      '[BeatAPI] providers synced',
    )
  })
}

/** 登出:摘掉两条托管条目,用户自己加的 provider 原样保留。 */
export async function removeBeatapiProvider(): Promise<ProvidersConfig> {
  return updateProviders((draft) => {
    draft.providers = draft.providers.filter(p => !BEATAPI_PROVIDER_IDS.includes(p.id))
  })
}

/** 面板判断"是否已接入"用 —— 有条目且带着 key 才算。 */
export function isBeatapiLinked(config: ProvidersConfig): boolean {
  return config.providers.some(
    p => BEATAPI_PROVIDER_IDS.includes(p.id) && Boolean(p.auth?.value),
  )
}
