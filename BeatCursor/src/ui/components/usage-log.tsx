/**
 * 使用日志 —— 按**文本模型**的花费与调用次数,来自 `GET /v1/usage`。
 *
 * 是**汇总**不是逐条流水:侧边栏放不下逐次调用,而"我这个月花在哪了"用汇总
 * 回答得更快。要看每一行有出口跳控制台。
 *
 * ⚠️ 只列文本。同一个账号的生图/视频花费也在 `/v1/usage` 里,但那是在别处
 * 花的钱 —— 摆在编辑器插件里会让人以为它在偷偷生成图片。合计也按文本重算,
 * 保证顶上的数字和底下的行是同一笔账(见 app.ts 的 rebuildUsage)。
 *
 * 未登录时整块不出现 —— 它是账号数据,没有可以先看看的版本。
 */
export function UsageLog() {
  return (
    <section x-show="$store.app.state?.beatapi?.linked">
      <h3>
        <span>Usage</span>
        <span class="h3-actions">
          <button class="tiny" x-on:click="$store.app.post('beatapiOpenLogs')">
            Full log
          </button>
        </span>
      </h3>

      <div x-show="!$store.app.usage" class="mp-empty">
        <span x-text="$store.app.usageLoading ? 'Loading usage…' : 'No usage loaded yet.'"></span>
      </div>

      <div x-show="$store.app.usage">
        <div class="ul-stats">
          <span class="ul-stat">
            <b x-text="'$' + ($store.app.usageTextSpend ?? 0).toFixed(2)"></b>
            <i>spent</i>
          </span>
          <span class="ul-stat">
            <b x-text="$store.app.usageTextCalls ?? 0"></b>
            <i>calls</i>
          </span>
          <span class="ul-stat">
            <b x-text="($store.app.usageRows ?? []).length"></b>
            <i>models</i>
          </span>
        </div>

        <div x-show="($store.app.usageRows ?? []).length === 0" class="mp-empty">
          No text usage yet.
        </div>

        <template x-for="row in ($store.app.usageRows ?? [])" x-bind:key="row.model">
          <div class="ul-row">
            <span class="ul-model" x-text="row.model || '(unknown)'"></span>
            <span class="ul-calls" x-text="row.tasks + '×'"></span>
            <span class="ul-spend" x-text="'$' + row.credits.toFixed(2)"></span>
          </div>
        </template>
      </div>
    </section>
  )
}
