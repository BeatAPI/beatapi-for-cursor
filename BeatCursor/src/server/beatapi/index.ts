/**
 * BeatAPI 接入的对外门面 —— 面板与命令只跟这一层打交道。
 *
 * 四件事:接入 (授权)、刷新 (目录 + 余额)、读状态、断开。
 * 各自的实现分散在同目录下,这里只负责把它们串成用户能理解的动作,
 * 并保证一件事:**任何一步失败都不会留下半接入状态**。
 */
import type { BeatapiUsage } from './account'
import type { AuthorizeHandle } from './auth'
import type { BeatapiCatalog } from './catalog'
import { loadProviders } from '../config/providersStore'
import { logger } from '../logger'
import { BeatapiApiError, fetchUsage, verifyKey } from './account'
import { startAuthorize } from './auth'
import { fetchCatalog } from './catalog'
import { BEATAPI_CONSOLE_PATHS, BEATAPI_CONSOLE_URL } from './constants'
import { clearCredentials, loadCredentials, updateCredentials } from './credentials'
import { isBeatapiLinked, removeBeatapiProvider, syncBeatapiProvider } from './provider'

export type { BeatapiUsage } from './account'
export type { AuthorizeHandle } from './auth'
export type { BeatapiCatalog, BeatapiModel } from './catalog'
export { BEATAPI_CONSOLE_PATHS, BEATAPI_CONSOLE_URL } from './constants'

export interface BeatapiStatus {
  linked: boolean
  accountLabel: string | null
  /** 已接入的模型数,两条 provider 加总。 */
  modelCount: number
  linkedAt: number
  /** 该 key 在网关里的 id,面板提示吊销时用。 */
  tokenId: number | null
}

export function getStatus(): BeatapiStatus {
  const credentials = loadCredentials()
  const providers = loadProviders()
  const modelCount = providers.providers
    .filter(p => p.id.startsWith('beatapi'))
    .reduce((sum, p) => sum + p.models.length, 0)
  return {
    linked: Boolean(credentials.relayKey) && isBeatapiLinked(providers),
    accountLabel: credentials.accountLabel,
    modelCount,
    linkedAt: credentials.linkedAt,
    tokenId: credentials.relayTokenId,
  }
}

/**
 * 起一次授权。
 *
 * 返回句柄给调用方去开浏览器;句柄的 `result` resolve 之后**还没接入完** ——
 * 必须接着调 completeLink。分两步是因为"开浏览器"这一步只有扩展宿主能做。
 */
export function beginLink(): Promise<AuthorizeHandle> {
  return startAuthorize(BEATAPI_CONSOLE_URL)
}

/**
 * 收下授权结果并完成接入。
 *
 * 顺序是刻意的:**先验 key,再拉目录,最后才落盘**。
 * 反过来会在 key 无效时留下一份写好的 providers.json 和一个看起来已接入
 * 的面板,而用户要到发第一条消息时才发现根本用不了。
 */
export async function completeLink(result: { key: string, tokenId: number, accountLabel: string }): Promise<BeatapiStatus> {
  const credentials = loadCredentials()
  const baseUrl = credentials.baseUrl

  if (!await verifyKey(result.key, baseUrl))
    throw new Error('BeatAPI rejected the key that authorization returned')

  const catalog = await fetchCatalog(baseUrl)
  await syncBeatapiProvider(catalog, result.key)
  await updateCredentials((draft) => {
    draft.relayKey = result.key
    draft.relayTokenId = result.tokenId || null
    draft.accountLabel = result.accountLabel || null
    draft.linkedAt = Date.now()
  })
  logger.info({ models: catalog.models.length }, '[BeatAPI] account linked')
  return getStatus()
}

/**
 * 面板用的目录 —— **不需要登录**。
 *
 * 与 refreshModels 的区别:那个是"把目录同步进 providers.json",要 key;
 * 这个只是"给面板看看有什么模型",匿名就能取。分开是因为广场在登录之前
 * 就该是满的 —— 空面板不会让人想登录,看得见价格的模型列表才会。
 */
export function fetchPlazaCatalog(): Promise<BeatapiCatalog> {
  return fetchCatalog(loadCredentials().baseUrl)
}

/**
 * 重新拉一次模型目录。
 *
 * 网关上下架模型之后不需要发新版扩展 —— 这就是目录不写死在客户端的意义。
 * 未接入时是空操作而不是报错:定时刷新会在用户还没登录时也跑到。
 */
export async function refreshModels(): Promise<BeatapiStatus> {
  const credentials = loadCredentials()
  if (!credentials.relayKey)
    return getStatus()
  const catalog = await fetchCatalog(credentials.baseUrl)
  await syncBeatapiProvider(catalog, credentials.relayKey)
  return getStatus()
}

/**
 * 取余额与用量。
 *
 * key 失效时**不自动断开** —— 断开会把用户配置好的模型全部摘掉,而一次 401
 * 也可能是网关正在重启。把判断交给用户:面板显示"需要重新授权"。
 */
export async function fetchAccountUsage(): Promise<BeatapiUsage | null> {
  const credentials = loadCredentials()
  if (!credentials.relayKey)
    return null
  try {
    return await fetchUsage(credentials.relayKey, credentials.baseUrl)
  }
  catch (err) {
    if (err instanceof BeatapiApiError && err.isAuthFailure) {
      logger.warn('[BeatAPI] relay key rejected — re-authorization needed')
      return null
    }
    throw err
  }
}

/**
 * 断开。
 *
 * 只清本地 —— 网关那把 key 还在,面板会提示去控制台吊销。做成本地优先是为了
 * 断网时也能退出;而"以为退干净了其实没有"比"提示你还要去吊销"更危险,
 * 所以提示不能省。
 */
export async function unlink(): Promise<{ status: BeatapiStatus, revokeUrl: string }> {
  await removeBeatapiProvider()
  await clearCredentials()
  return {
    status: getStatus(),
    revokeUrl: `${BEATAPI_CONSOLE_URL}${BEATAPI_CONSOLE_PATHS.apiKeys}`,
  }
}
