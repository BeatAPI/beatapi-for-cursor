/**
 * BeatAPI 接入的固定坐标。
 *
 * 只放"改一次就要改全套"的常量:域名、路径、provider id。
 * 模型清单**不在这里** —— 那是数据,运行时从网关取 (见 catalog.ts)。
 */

/** 公开 API 域名。客户流量、账号接口、计价接口都在这个域上。 */
export const BEATAPI_BASE_URL = 'https://api.beatapi.io'

/**
 * 两个 SDK 要的 baseUrl **不一样**,不能共用一个值:
 *   - openai SDK 往 `${baseURL}/chat/completions` 发 → 必须带 `/v1`
 *   - @anthropic-ai/sdk 往 `${baseURL}/v1/messages` 发 → 必须**不带** `/v1`
 * 填错的表现是 404,而 404 看起来像"模型没上线",很容易查错方向。
 */
export const BEATAPI_OPENAI_BASE_URL = `${BEATAPI_BASE_URL}/v1`
export const BEATAPI_ANTHROPIC_BASE_URL = BEATAPI_BASE_URL

/** 面向人的控制台。浏览器打开用,不要拿它发 API 请求。 */
export const BEATAPI_CONSOLE_URL = 'https://beatapi.io'

export const BEATAPI_CONSOLE_PATHS = {
  credits: '/dashboard/credits',
  apiKeys: '/dashboard/apikeys',
  textUsage: '/dashboard/text-usage',
  logs: '/dashboard/logs',
} as const

/**
 * Provider 条目 id。
 *
 * 分成两条是因为宿主的 ProviderEntry 一条只能有一个 type,而 Claude 走
 * 原生 `/v1/messages` 比走 OpenAI 兼容层更完整 (thinking block、tool 语义、
 * cache control 都不必经过一次有损转换)。两条共用同一把 key。
 *
 * 哪些模型进哪条**不是写死的** —— 按网关 `/api/pricing` 报的
 * `supported_endpoint_types` 分流,新模型上线时自动落到对的那条。
 */
export const BEATAPI_PROVIDER_ID = 'beatapi'
export const BEATAPI_CLAUDE_PROVIDER_ID = 'beatapi-claude'
export const BEATAPI_PROVIDER_IDS: readonly string[] = [
  BEATAPI_PROVIDER_ID,
  BEATAPI_CLAUDE_PROVIDER_ID,
]

/** 凭据文件名 (落在 ~/.beatcursor/ 下,与 providers.json 同级)。 */
export const BEATAPI_CREDENTIALS_FILE_NAME = 'beatapi.json'

/** 网关公开接口。改动前先确认目标部署上确实提供了这条路径。 */
export const BEATAPI_ENDPOINTS = {
  /**
   * 文本模型目录 —— 网关权威的那份,含上下文与最大输出。无需鉴权。
   * 运营改完立刻生效,客户端不用发版。老网关上没有这条,调用方要能退回 pricing。
   */
  textModels: '/v1/text/models',
  /** 公开计价表:模型清单 + 分组 + 端点能力。无需鉴权。退路。 */
  pricing: '/api/pricing',
  /** 站点配置,含 quota_per_unit 与显示币种。无需鉴权。 */
  status: '/api/status',
  /** 账号自身信息,含余额。接受 session token 或 PAT。 */
  self: '/api/user/self',
  /** 令牌管理 —— 授权成功后在这里铸一把中继 key。 */
  tokens: '/api/token',
  /** 明细日志 (每次调用一行)。 */
  logs: '/api/log/self',
  /** 按小时聚合的用量,画图用。 */
  usage: '/api/data/self',
  /** 充值档位与支付方式。 */
  topupInfo: '/api/user/topup/info',
  /** 用户名密码登录前先取公钥,密码不明文上行。 */
  loginEncryptionKey: '/api/user/login/encryption-key',
  login: '/api/user/login',
} as const

/**
 * 令牌名前缀。带机器名,便于用户在控制台里认出"这把是哪台电脑的 Cursor"
 * 并单独吊销,而不是看到一排 `token-1` 只能全删。
 */
export const BEATAPI_TOKEN_NAME_PREFIX = 'beatcursor'

/**
 * 分组。`auto` 是令牌级伪分组 —— 一把令牌就能够到全部文本家族,
 * 不必按家族各发一把。详见网关侧 docs/channel/。
 */
export const BEATAPI_TOKEN_GROUP = 'auto'

/**
 * 额度 → 货币的换算兜底值。
 *
 * ⚠️ 真值由网关 `/api/status` 的 `quota_per_unit` 给,**优先用那个**。
 * 这里只是取不到时的兜底 —— 写死会在运营调整换算比时静默显示错的余额,
 * 而余额显示错比不显示更糟。
 */
export const BEATAPI_QUOTA_PER_UNIT_FALLBACK = 500000
