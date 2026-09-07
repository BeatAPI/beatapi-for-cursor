/**
 * BeatAPI 账号面 —— 余额与用量。
 *
 * 只用**中继 key** 一把凭据,不持有 session 也不持有 PAT。
 *
 * 这不是省事,是刻意收窄授权范围:`GET /v1/usage` 认 key,回的正好是余额、
 * 已结算/已退款、按模型与按 key 的用量分解。而 `/api/user/self` 那条路要
 * session 或 PAT —— PAT 等于把整个账号(改密码、开退款、建令牌)交给一个
 * 编辑器插件,为了显示一个余额数字不值得。
 *
 * 代价是拿不到**逐次调用**的明细(那在 `/api/log/self`)。面板显示按模型的
 * 汇总,要看每一行就跳控制台 —— 侧边栏本来也放不下逐行日志。
 *
 * ⚠️ 老部署上可能没有这条路径,回的是 404。调用方要把它读成"这个部署不提供
 * 用量接口",而不是读成账号有问题。
 */
import { logger } from '../logger'
import { BEATAPI_BASE_URL } from './constants'

/** `/v1/usage` 的返回。credit 就是美元,1 credit = $1,可能为负。 */
export interface BeatapiUsage {
  /** 账号显示名。扩展没有登录界面,这是唯一能回答"我登录的是谁"的地方。 */
  accountName: string
  creditBalance: number
  creditsSettled: number
  creditsRefunded: number
  concurrency: { limit: number, active: number }
  byModel: Array<{ model: string, mediaType: string, tasks: number, credits: number }>
  byApiKey: Array<{ title: string, keyPrefix: string, tasks: number, credits: number }>
  totalTasks: number
  /**
   * 只含**文本模型**的用量,以及按这个子集重算的合计。
   *
   * 在这里算一次而不是让每个界面各自 filter:面板和 ⌘⌥U 弹层是两个独立的
   * bundle(webview / extension host),各写一遍迟早会漂移成两个数。
   *
   * 合计必须跟着子集重算 —— 账号总额里有生图/视频的钱,直接显示会和列出来的
   * 行对不上,而对不上的账没人敢信。
   */
  text: {
    rows: Array<{ model: string, mediaType: string, tasks: number, credits: number }>
    spend: number
    calls: number
  }
}

export class BeatapiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BeatapiApiError'
  }

  /** 凭据问题 —— 应当引导重新授权,而不是重试。 */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403
  }
}

interface RawUsage {
  account_name?: string
  credit_balance?: number
  credits_settled?: number
  credits_refunded?: number
  total_tasks?: number
  concurrency?: { limit?: number, active?: number }
  by_model?: Array<{ model?: string, media_type?: string, tasks?: number, credits_settled?: number }>
  by_api_key?: Array<{ title?: string, key_prefix?: string, tasks?: number, credits_settled?: number }>
}

/**
 * 取账号用量。
 *
 * 返回的是 `{ data: … }` 信封;网关出错时回的是 `{ error: { message } }`
 * (BeatAPI 形状),两种都要认 —— 只认一种会把真实原因吞掉,只剩一个状态码。
 */
export async function fetchUsage(
  key: string,
  baseUrl: string = BEATAPI_BASE_URL,
): Promise<BeatapiUsage> {
  const res = await fetch(`${baseUrl}/v1/usage`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
  })
  const text = await res.text()
  let body: { data?: RawUsage, error?: { message?: string } } | null = null
  try {
    body = text ? JSON.parse(text) : null
  }
  catch {
    // 不是 JSON 基本只有一种可能:请求没到网关,被最前面那层挡了(它回 HTML)。
    throw new BeatapiApiError(`unexpected response from /v1/usage: ${text.slice(0, 120)}`, res.status)
  }
  if (!res.ok)
    throw new BeatapiApiError(body?.error?.message || `usage request failed with ${res.status}`, res.status)

  const raw = body?.data ?? {}
  const byModel = (raw.by_model ?? [])
    .map(row => ({
      model: String(row.model ?? ''),
      mediaType: String(row.media_type ?? ''),
      tasks: Number(row.tasks) || 0,
      credits: Number(row.credits_settled) || 0,
    }))
    // 花得最多的排前面 —— 面板只放得下几行,那几行应该是最值得看的。
    .sort((a, b) => b.credits - a.credits)

  // 网关把认不出的模型标成 "other" 而不是塞进 text,所以这里按等于 text 取,
  // 不能按"不是 image/video"取 —— 后者会把 other 也算进来。
  const textRows = byModel.filter(row => row.mediaType === 'text')

  return {
    text: {
      rows: textRows,
      spend: textRows.reduce((sum, row) => sum + row.credits, 0),
      calls: textRows.reduce((sum, row) => sum + row.tasks, 0),
    },
    // 老网关不返回这个字段 —— 空串让界面退回只显示品牌名,不显示占位。
    accountName: String(raw.account_name ?? ''),
    creditBalance: Number(raw.credit_balance) || 0,
    creditsSettled: Number(raw.credits_settled) || 0,
    creditsRefunded: Number(raw.credits_refunded) || 0,
    totalTasks: Number(raw.total_tasks) || 0,
    concurrency: {
      limit: Number(raw.concurrency?.limit) || 0,
      active: Number(raw.concurrency?.active) || 0,
    },
    byModel,
    byApiKey: (raw.by_api_key ?? []).map(row => ({
      title: String(row.title ?? ''),
      keyPrefix: String(row.key_prefix ?? ''),
      tasks: Number(row.tasks) || 0,
      credits: Number(row.credits_settled) || 0,
    })),
  }
}

/**
 * 用一次真实调用验证 key 还有效。
 *
 * 授权刚结束时调一次:与其等用户发第一条消息才发现 key 不对,不如当场说清楚。
 */
export async function verifyKey(key: string, baseUrl: string = BEATAPI_BASE_URL): Promise<boolean> {
  try {
    await fetchUsage(key, baseUrl)
    return true
  }
  catch (err) {
    if (err instanceof BeatapiApiError && err.isAuthFailure)
      return false
    // 网络不通不代表 key 有问题。判成无效会让用户在断网时被踢去重新授权。
    logger.warn({ err: (err as Error).message }, '[BeatAPI] key verification inconclusive')
    return true
  }
}
