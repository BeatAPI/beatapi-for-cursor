/**
 * BeatAPI 凭据的落盘与读取。
 *
 * 只存**一样东西**:授权时铸出来的中继 key。
 *
 * 刻意不存 session / PAT —— 账号面(余额、用量)走 `GET /v1/usage`,那条也认
 * 这把 key。多存一个账号级凭据只会扩大失窃时的影响面,换不来任何本地能力:
 * 改密码、开发票、退款这些事都在浏览器里做。
 *
 * 文件权限 0600 —— 里面是能花钱的东西。
 */
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonOrNull, withSerial, writeJsonAtomic } from '../config/atomic'
import { getConfigDir } from '../config/paths'
import { logger } from '../logger'
import { BEATAPI_BASE_URL, BEATAPI_CREDENTIALS_FILE_NAME } from './constants'

export interface BeatapiCredentials {
  $schemaVersion: number
  baseUrl: string
  /** 中继 key,形如 `sk-…`。未授权时为 null。 */
  relayKey: string | null
  /** 该 key 在网关里的 id。登出时提示用户去哪一条上吊销。 */
  relayTokenId: number | null
  /** 授权页回传的展示名,只用于面板上显示"以谁的身份接入"。 */
  accountLabel: string | null
  /** 授权时间 (Unix 毫秒)。 */
  linkedAt: number
}

const EMPTY: BeatapiCredentials = {
  $schemaVersion: 1,
  baseUrl: BEATAPI_BASE_URL,
  relayKey: null,
  relayTokenId: null,
  accountLabel: null,
  linkedAt: 0,
}

const FILE_MODE = 0o600

export function getCredentialsFilePath(): string {
  return join(getConfigDir(), BEATAPI_CREDENTIALS_FILE_NAME)
}

function normalize(loaded: Partial<BeatapiCredentials> | null): BeatapiCredentials {
  if (!loaded)
    return { ...EMPTY }
  return {
    $schemaVersion: loaded.$schemaVersion ?? EMPTY.$schemaVersion,
    baseUrl: loaded.baseUrl?.trim() || BEATAPI_BASE_URL,
    relayKey: typeof loaded.relayKey === 'string' && loaded.relayKey ? loaded.relayKey : null,
    relayTokenId: typeof loaded.relayTokenId === 'number' ? loaded.relayTokenId : null,
    accountLabel: typeof loaded.accountLabel === 'string' && loaded.accountLabel ? loaded.accountLabel : null,
    linkedAt: Number(loaded.linkedAt) || 0,
  }
}

let cache: BeatapiCredentials | null = null

export function loadCredentials(): BeatapiCredentials {
  if (cache)
    return cache
  cache = normalize(readJsonOrNull<Partial<BeatapiCredentials>>(getCredentialsFilePath()))
  return cache
}

export async function updateCredentials(
  updater: (draft: BeatapiCredentials) => void,
): Promise<BeatapiCredentials> {
  const path = getCredentialsFilePath()
  return withSerial(path, () => {
    const current = normalize(readJsonOrNull<Partial<BeatapiCredentials>>(path))
    updater(current)
    writeJsonAtomic(path, current, { mode: FILE_MODE })
    cache = current
    return current
  })
}

/**
 * 清除本地凭据。
 *
 * 只删本地。网关那把 key 留着 —— 断网时也必须能登出,把"删不掉远端"变成
 * "本地也退不出"会让用户卡在一个既用不了又退不出的状态。面板负责提示
 * 去控制台吊销。
 */
export async function clearCredentials(): Promise<void> {
  const path = getCredentialsFilePath()
  await withSerial(path, () => {
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      }
      catch (err) {
        logger.warn({ err: (err as Error).message }, '[BeatAPI] could not remove credentials file')
      }
    }
    cache = { ...EMPTY }
  })
}

export function isLinked(credentials: BeatapiCredentials = loadCredentials()): boolean {
  return Boolean(credentials.relayKey)
}

/** 测试用: 重置进程内缓存 */
export function resetCredentialsCacheForTests(): void {
  cache = null
}
