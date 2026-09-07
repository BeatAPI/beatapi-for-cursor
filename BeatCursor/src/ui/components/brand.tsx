/**
 * BeatAPI 品牌资产 —— 标志与页眉。
 *
 * 标志是**内联 SVG 而不是 PNG**:webview 的 HTML 是 extension host 一次性拼出来的
 * 字符串,引外部图片要走 `asWebviewUri` 和 CSP,而这个标志本身只是七个圆角矩形 ——
 * 内联之后无请求、无 CSP、任意缩放,而且暗色下的那七根可以直接跟着 currentColor 走。
 *
 * 几何是从 `BeatAPI/public/logo-light.png`(1024×1024)逐像素量出来的,不是照着眼睛
 * 描的:蓝色主干 x=233..359 / y=52..971,右侧三列各自的上下两段起止都对齐原图。
 * 改动前请重新量,别凭印象调 —— 这个标志的辨识度全在那几段长短比例上。
 */

/** 品牌蓝。取自标志主干的实测像素值 rgb(18,88,255)。 */
export const BEATAPI_BLUE = '#1258FF'

/**
 * 标志。
 *
 * `size` 是边长(标志是正方形画布)。非主干的六根用 currentColor,
 * 所以放在深色面板里是浅色、浅色面板里是深色,不必准备两份资源。
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style="flex-shrink:0"
    >
      {/* 主干 —— 唯一上色的一根 */}
      <rect x="233" y="52" width="127" height="920" rx="63.5" fill={BEATAPI_BLUE} />
      {/* 第二列 */}
      <rect x="396" y="52" width="119" height="438" rx="59.5" fill="currentColor" />
      <rect x="396" y="535" width="119" height="437" rx="59.5" fill="currentColor" />
      {/* 第三列 */}
      <rect x="546" y="111" width="119" height="366" rx="59.5" fill="currentColor" />
      <rect x="546" y="550" width="119" height="394" rx="59.5" fill="currentColor" />
      {/* 第四列 */}
      <rect x="695" y="209" width="95" height="248" rx="47.5" fill="currentColor" />
      <rect x="695" y="584" width="95" height="266" rx="47.5" fill="currentColor" />
    </svg>
  )
}

/**
 * 面板页眉 —— 标志 + 账号 + 余额,一行。
 *
 * 账号那套东西压缩成这一行,不再单独占一张卡:面板的主体应该是模型和用量,
 * 「我是谁、还有多少钱」是一直要看得见的**状态**,不是要反复操作的功能。
 *
 * 余额本身就是充值按钮 —— 会去点余额的人,想做的正是充值。
 */
export function BrandHeader() {
  return (
    <header class="ba-header">
      <span class="ba-logo">
        <BrandMark size={17} />
        <span class="ba-id">
          <span class="ba-wordmark">BeatAPI</span>
          {/* 账号名优先用网关回的(权威),授权回调带的那个只作兜底 ——
              老网关不返回 account_name,那时至少还认得出是哪个账号。 */}
          <span
            class="ba-account"
            x-show="$store.app.state?.beatapi?.linked"
            x-text="$store.app.usage?.accountName || $store.app.state?.beatapi?.accountLabel || 'signed in'"
          >
          </span>
        </span>
      </span>

      <span class="ba-right">
        {/* 已登录:余额 → 充值页 */}
        <button
          class="ba-balance"
          x-show="$store.app.state?.beatapi?.linked"
          x-bind:title="$store.app.state?.beatapi?.accountLabel || ''"
          x-on:click="$store.app.post('beatapiTopUp')"
          x-text="$store.app.beatapiBalance || '—'"
        >
        </button>
        <button
          class="ba-more"
          x-show="$store.app.state?.beatapi?.linked"
          title="Account"
          x-on:click="$store.app.post('beatapiSignOut')"
        >
          ⋯
        </button>

        {/* 未登录:一个入口,别的什么都不放 */}
        <button
          class="ba-signin"
          x-show="!$store.app.state?.beatapi?.linked"
          x-on:click="$store.app.post('beatapiSignIn')"
        >
          Sign in
        </button>
      </span>
    </header>
  )
}
