/**
 * Root layout — Hono JSX 生成完整 HTML, 内嵌 Alpine 指令 + webview JS
 *
 * renderHtml(webviewJs) 在 extension host 侧调用一次,
 * 产出的 HTML 字符串赋给 webview.html, 之后 Alpine.js 接管所有交互。
 *
 * 版面顺序即优先级:**使用日志 → 模型广场 → 高级设置**。
 *
 * 用量在最上面,因为它是**会变的那个** —— 每次打开面板想知道的是"我花了多少",
 * 而模型清单基本是静态的,看一次就知道有什么了。未登录时用量整块不出现
 * (它是账号数据),那时第一眼落在模型广场上,正好是没登录的人该看的东西。
 *
 * Advanced 里**只剩 BYOK 开关**一件事 —— 那是唯一一个用户可能真的要动的机制
 * (切回官方 Cursor)。Server 的起停、Providers 编辑、Web Tools 都从面板上撤了:
 * 服务由扩展自己管,provider 由登录自动配。
 *
 * 撤的是**界面**不是能力:providers.json 原样在,命令面板里的
 * `BeatAPI: Edit Providers Config` 仍然能打开它 —— 自己配过 provider 的人
 * 不会因为界面简化而丢东西。
 */
import { Banner } from './banner'
import { BrandHeader } from './brand'
import { ModelPlaza } from './model-plaza'
import { styles } from './styles'
import { ToastContainer } from './toast'
import { UsageLog } from './usage-log'
import { Welcome } from './welcome'

function Layout({ webviewJs, codiconUri }: { webviewJs: string, codiconUri?: string }) {
  const codiconCss = codiconUri
    ? `@font-face { font-family: 'codicon'; font-display: block; src: url('${codiconUri}') format('truetype'); }
       .codicon { font-family: 'codicon'; font-size: 14px; line-height: 1; display: inline-block; -webkit-font-smoothing: antialiased; }
       .codicon::before { display: inline-block; }
       .codicon-eye::before { content: "\\ea70"; }
       .codicon-eye-closed::before { content: "\\eae7"; }`
    : ''

  return (
    <html>
      <head>
        <meta charset="UTF-8" />
        {/* ⚠️ 必须走 dangerouslySetInnerHTML:Hono JSX 会转义文本子节点,
            而 CSS 里的子代选择器 `>` 被转成 `&gt;` 之后**整条规则静默失效** ——
            页面照常渲染,只是那几条样式不生效,没有任何报错。 */}
        <style dangerouslySetInnerHTML={{ __html: codiconCss + styles }} />
      </head>
      <body x-data>
        <BrandHeader />

        <Welcome />

        <UsageLog />

        <ModelPlaza />

        <details class="ba-advanced">
          <summary>
            <span>Advanced</span>
            {/* 不写 "BYOK" —— 见 banner.tsx 上的说明 */}
            <span
              class="ba-advanced-hint"
              x-text="($store.app.state?.byokMode ? 'BeatAPI' : 'Cursor') + ' · v' + ($store.app.state?.version || '')"
            >
            </span>
          </summary>

          <Banner />
        </details>

        <ToastContainer />

        <script dangerouslySetInnerHTML={{ __html: webviewJs }} />
      </body>
    </html>
  )
}

/** 生成完整 HTML 字符串 (extension host 侧调用) */
export function renderHtml(webviewJs: string, codiconUri?: string): string {
  const html = (<Layout webviewJs={webviewJs} codiconUri={codiconUri} />).toString()
  return `<!DOCTYPE html>${html}`
}
