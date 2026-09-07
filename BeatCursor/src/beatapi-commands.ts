/**
 * BeatAPI 的编辑器命令 —— 登录、余额/用量、刷新模型、充值。
 *
 * 单独一个文件是为了让 extension.ts 只多一行注册调用:那个文件已经承担了
 * 服务器生命周期、状态栏、补丁检测,再塞进来一套账号 UI 会更难读。
 */
import * as vscode from 'vscode'
import {
  BEATAPI_CONSOLE_PATHS,
  BEATAPI_CONSOLE_URL,
  beginLink,
  completeLink,
  fetchAccountUsage,
  getStatus,
  refreshModels,
  unlink,
} from './server/beatapi'
import { logger } from './server/logger'

function consoleUrl(path: string): vscode.Uri {
  return vscode.Uri.parse(`${BEATAPI_CONSOLE_URL}${path}`)
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * 授权登录。
 *
 * 进度条挂在 Notification 上而不是静默等待:浏览器一旦被切到前台,编辑器这边
 * 就没有任何动静了,用户需要一个"还在等你"的凭据,以及一个取消的入口。
 */
async function signIn(onChanged: () => void): Promise<void> {
  const handle = await beginLink()
  const opened = await vscode.env.openExternal(vscode.Uri.parse(handle.url))
  if (!opened) {
    handle.cancel()
    vscode.window.showErrorMessage('Could not open the browser for BeatAPI sign-in.')
    return
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'BeatAPI: waiting for authorization in your browser…',
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => handle.cancel())
      try {
        const result = await handle.result
        const status = await completeLink(result)
        onChanged()
        vscode.window.showInformationMessage(
          `BeatAPI connected${status.accountLabel ? ` as ${status.accountLabel}` : ''} — ${status.modelCount} models available.`,
        )
      }
      catch (err) {
        const message = (err as Error).message
        // 取消和超时是正常路径,不该弹成错误 —— 用户刚刚才主动点的取消。
        if (/cancelled|timed out/i.test(message)) {
          logger.info({ message }, '[BeatAPI] sign-in abandoned')
          return
        }
        vscode.window.showErrorMessage(`BeatAPI sign-in failed: ${message}`)
      }
    },
  )
}

async function signOut(onChanged: () => void): Promise<void> {
  const status = getStatus()
  if (!status.linked) {
    vscode.window.showInformationMessage('BeatAPI is not connected.')
    return
  }
  const confirm = await vscode.window.showWarningMessage(
    'Disconnect BeatAPI? The built-in models will be removed from Cursor.',
    { modal: true },
    'Disconnect',
  )
  if (confirm !== 'Disconnect')
    return

  const { revokeUrl } = await unlink()
  onChanged()
  // 本地清干净了,但网关那把 key 还在。不说这句会让人以为已经彻底断开,
  // 而一把还有效的 key 留在别处是实打实的风险。
  const choice = await vscode.window.showInformationMessage(
    'BeatAPI disconnected locally. The API key still exists in your BeatAPI account.',
    'Revoke it in the console',
  )
  if (choice)
    await vscode.env.openExternal(vscode.Uri.parse(revokeUrl))
}

/**
 * 余额与用量。
 *
 * 用 QuickPick 而不是新开一个 webview:这是"看一眼就走"的信息,再开一个面板
 * 反而更慢。花得最多的模型排在前面,后面永远跟着两个出口(完整日志、充值)。
 */
async function showUsage(): Promise<void> {
  if (!getStatus().linked) {
    const choice = await vscode.window.showInformationMessage(
      'Connect your BeatAPI account to see your balance.',
      'Sign in',
    )
    if (choice)
      await vscode.commands.executeCommand('beatcursor.signIn')
    return
  }

  const usage = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'BeatAPI: loading usage…' },
    () => fetchAccountUsage(),
  )
  if (!usage) {
    const choice = await vscode.window.showWarningMessage(
      'BeatAPI rejected the stored key. Sign in again to restore access.',
      'Sign in',
    )
    if (choice)
      await vscode.commands.executeCommand('beatcursor.signIn')
    return
  }

  const items: Array<vscode.QuickPickItem & { url?: vscode.Uri }> = [
    {
      label: `$(credit-card) Balance  ${money(usage.creditBalance)}`,
      // 这一行是**整个账号**的口径,底下的按模型明细只有文本 —— 两个数字对不上
      // 是正常的,所以标签必须说清楚是哪一种,否则看起来就像算错了。
      detail: `Account total: spent ${money(usage.creditsSettled)} · refunded ${money(usage.creditsRefunded)} · ${usage.totalTasks} requests`,
      url: consoleUrl(BEATAPI_CONSOLE_PATHS.credits),
    },
  ]

  // 只列文本。同一个账号的生图/视频花费也在 /v1/usage 里,但那是在别处花的钱 ——
  // 摆在编辑器插件里会让人以为它在偷偷生成图片。合计同样按文本口径(见 account.ts)。
  if (usage.text.rows.length > 0) {
    items.push({
      label: `Text models  ${money(usage.text.spend)} · ${usage.text.calls} requests`,
      kind: vscode.QuickPickItemKind.Separator,
    })
    // 只放前八条:侧边弹层再长就要滚动了,而排在后面的都是零头。
    for (const row of usage.text.rows.slice(0, 8)) {
      items.push({
        label: row.model || '(unknown)',
        description: money(row.credits),
        detail: `${row.tasks} request${row.tasks === 1 ? '' : 's'}`,
        url: consoleUrl(BEATAPI_CONSOLE_PATHS.textUsage),
      })
    }
  }

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Top up', url: consoleUrl(BEATAPI_CONSOLE_PATHS.credits) },
    { label: '$(link-external) Open full usage log', url: consoleUrl(BEATAPI_CONSOLE_PATHS.logs) },
  )

  const picked = await vscode.window.showQuickPick(items, {
    title: `BeatAPI · ${money(usage.creditBalance)} remaining`,
    placeHolder: 'Select an entry to open it in the console',
  })
  if (picked?.url)
    await vscode.env.openExternal(picked.url)
}

export function registerBeatapiCommands(
  context: vscode.ExtensionContext,
  onChanged: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('beatcursor.signIn', () => signIn(onChanged)),
    vscode.commands.registerCommand('beatcursor.signOut', () => signOut(onChanged)),
    vscode.commands.registerCommand('beatcursor.showUsage', () => showUsage()),
    // 充值快捷键指向的就是这条 —— 直接开充值页,不加中间步骤。
    vscode.commands.registerCommand('beatcursor.topUp', async () => {
      await vscode.env.openExternal(consoleUrl(BEATAPI_CONSOLE_PATHS.credits))
    }),
    vscode.commands.registerCommand('beatcursor.refreshModels', async () => {
      if (!getStatus().linked) {
        vscode.window.showInformationMessage('Connect your BeatAPI account first.')
        return
      }
      try {
        const status = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'BeatAPI: refreshing models…' },
          () => refreshModels(),
        )
        onChanged()
        vscode.window.showInformationMessage(`BeatAPI: ${status.modelCount} models available.`)
      }
      catch (err) {
        vscode.window.showErrorMessage(`BeatAPI model refresh failed: ${(err as Error).message}`)
      }
    }),
  )
}
