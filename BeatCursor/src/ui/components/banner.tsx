/**
 * 路由开关 —— 请求走 BeatAPI 还是走 Cursor 官方。
 *
 * ⚠️ 文案刻意**不出现 "BYOK"**。那是上游项目的术语,对客户既没有信息量,
 * 又直接指向这个客户端是从哪儿来的。用户真正要知道的只有一件事:
 * 我这些请求现在打给谁、钱记在谁头上。
 *
 * 配置里的字段名仍是 `byokMode` —— 那是 routes.json 的 schema,
 * 安装器和注入脚本都按它读,改字段名是另一件事,与文案无关。
 */
export function Banner() {
  return (
    <div x-show="$store.app.state" class="byok-banner">
      <div class="byok-label">
        <span
          class="byok-title"
          x-text="$store.app.state?.byokMode ? 'Routing: BeatAPI' : 'Routing: Cursor'"
        >
        </span>
        <span
          class="byok-hint"
          x-text="$store.app.state?.byokMode ? 'Requests and billing go through your BeatAPI account' : 'Requests go to Cursor with your Cursor subscription'"
        >
        </span>
      </div>
      <button
        x-bind:class="$store.app.state?.byokMode ? 'on' : 'off'"
        x-text="$store.app.state?.byokMode ? 'Use Cursor' : 'Use BeatAPI'"
        x-on:click="$store.app.post('toggleByok')"
      >
      </button>
    </div>
  )
}
