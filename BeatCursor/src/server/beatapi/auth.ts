/**
 * BeatAPI 授权登录 —— 浏览器授权 + 本地回环接收。
 *
 * 形状是原生应用的标准做法 (OAuth 的 loopback redirect),不是自创:
 *
 *   1. 扩展在 127.0.0.1 上开一个**一次性**监听口,随机端口;
 *   2. 用系统浏览器打开控制台的授权页,带上回调地址与随机 state;
 *   3. 用户在**自己已经登录的浏览器里**点同意 —— 密码、二次验证、OAuth
 *      全程在浏览器里发生,扩展从头到尾看不到;
 *   4. 控制台铸一把中继 key,重定向回本地口;
 *   5. 扩展校验 state、收下 key、立刻关掉监听。
 *
 * 为什么不做"面板里输账号密码":那会让扩展经手口令,还得自己实现二次验证、
 * 验证码、OAuth 三条分支 —— 每一条都是浏览器里已经做好且做得更对的东西。
 *
 * 为什么不让用户去控制台复制 key 粘回来:能用,但那正是魔尊要替换掉的
 * "贴 key" 体验。
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { logger } from '../logger'
import { BEATAPI_CONSOLE_URL } from './constants'

/** 授权页在控制台上的路径。 */
const AUTHORIZE_PATH = '/authorize'

/** 回调路径 —— 只认这一个,其余一律 404。 */
const CALLBACK_PATH = '/beatcursor/callback'

/**
 * 等用户操作的上限。
 *
 * 五分钟:够一个没登录的用户走完登录甚至注册,又不至于让一个被放弃的授权
 * 把端口占到 Cursor 关闭。超时后端口立即释放,用户重新点一次即可。
 */
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000

export interface AuthorizeResult {
  /** 中继 key,形如 `sk-…`。 */
  key: string
  /** 该 key 在网关里的 id —— 面板提示用户去控制台哪一条上吊销。 */
  tokenId: number
  /** 展示名 (用户名或邮箱),只用于面板显示"以谁的身份接入"。可能为空。 */
  accountLabel: string
}

export interface AuthorizeHandle {
  /** 要在浏览器里打开的地址。调用方负责真正去打开它。 */
  url: string
  /** 授权结果。用户取消或超时则 reject。 */
  result: Promise<AuthorizeResult>
  /** 主动放弃 —— 关端口、让 result reject。面板上的"取消"用。 */
  cancel: () => void
}

function html(title: string, body: string): string {
  // 回给浏览器的落地页。刻意不引任何外部资源:授权成功这一刻网络可能正好
  // 不通,而一个加载不出来的空白页会让用户以为授权失败又点一次。
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0d0d0f;color:#e8e8ea">`
    + `<div style="text-align:center;max-width:30rem;padding:2rem">${body}</div></body>`
}

/**
 * 起一次授权。
 *
 * 返回的是**句柄不是结果** —— 调用方需要先拿到 url 去开浏览器,再 await
 * result。合成一个 Promise 会让"开浏览器"这一步没地方放。
 */
export function startAuthorize(consoleUrl: string = BEATAPI_CONSOLE_URL): Promise<AuthorizeHandle> {
  const state = randomBytes(24).toString('base64url')

  return new Promise((resolveHandle, rejectHandle) => {
    let settle: ((value: AuthorizeResult) => void) | null = null
    let fail: ((err: Error) => void) | null = null
    const result = new Promise<AuthorizeResult>((res, rej) => {
      settle = res
      fail = rej
    })

    let timer: NodeJS.Timeout | null = null
    let closed = false
    // 先声明后赋值:close 要在请求处理器里被引用,而处理器是构造 server 的实参。
    let server: Server | null = null
    const close = () => {
      if (closed)
        return
      closed = true
      if (timer)
        clearTimeout(timer)
      server?.close()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }

      const respond = (status: number, page: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
      }

      // state 不符一律拒绝,并且**不关服务器** —— 一个猜错 state 的请求不该
      // 让正在进行的真授权失效。
      if (url.searchParams.get('state') !== state) {
        logger.warn('[BeatAPI] authorize callback with bad state, ignored')
        respond(400, html('BeatAPI', '<h2>Authorization mismatch</h2><p>Please start the sign-in again from Cursor.</p>'))
        return
      }

      const error = url.searchParams.get('error')
      if (error) {
        respond(200, html('BeatAPI', `<h2>Sign-in cancelled</h2><p>${escapeHtml(error)}</p>`))
        close()
        fail?.(new Error(error))
        return
      }

      const key = url.searchParams.get('key')?.trim()
      const tokenId = Number(url.searchParams.get('token_id')) || 0
      if (!key) {
        respond(400, html('BeatAPI', '<h2>Sign-in failed</h2><p>The console did not return a key.</p>'))
        close()
        fail?.(new Error('authorization returned no key'))
        return
      }

      respond(200, html('BeatAPI', '<h2>Signed in</h2><p>You can close this tab and go back to Cursor.</p>'))
      close()
      settle?.({ key, tokenId, accountLabel: url.searchParams.get('account')?.trim() ?? '' })
    })

    server.on('error', err => rejectHandle(err))

    // 只听回环。0.0.0.0 会把这个口暴露到局域网,而它在几分钟内会接受一把
    // 能花钱的 key。
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const params = new URLSearchParams({
        client: 'beatcursor',
        redirect_uri: redirectUri,
        state,
      })
      timer = setTimeout(() => {
        close()
        fail?.(new Error('authorization timed out'))
      }, AUTHORIZE_TIMEOUT_MS)
      // 未处理的 rejection 会在 Cursor 的扩展宿主里刷错误日志,而超时/取消
      // 都是正常路径。调用方仍然能 await 到同一个 rejection。
      result.catch(() => undefined)

      logger.info({ port }, '[BeatAPI] authorization listener started')
      resolveHandle({
        url: `${consoleUrl}${AUTHORIZE_PATH}?${params.toString()}`,
        result,
        cancel: () => {
          close()
          fail?.(new Error('authorization cancelled'))
        },
      })
    })
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch] ?? ch
  ))
}
