/**
 * 模型广场 —— 面板的主体。
 *
 * 按家族分组列出可用的文本模型,每条带上下文、折扣与零售价。数据来自网关的
 * `GET /v1/text/models`,**匿名就能取**,所以没登录时这块照样是满的 ——
 * 一个空面板不会让人想登录,一个看得见价格的模型列表才会。
 *
 * 默认全部折叠:三十个模型摊开是一堵墙,而人一次只关心一个家族。
 *
 * 行上显示的是**模型 id 本身**,不是美化过的展示名。用户在配置、日志、账单里
 * 看到的都是 id;而展示名来自两个不同来源(快照名 / 本地美化),混在一起会出现
 * 「Gpt 5.6 Sol」和「claude-haiku-4-5-20251001」并排这种不一致。
 *
 * 价格是**起价**:分档计价的模型超过阈值之后更贵,那一档不显示在这里。
 * 把贵的那档当成"这个模型的价格"是两种错法里更误导人的一种。
 */

/** 单条模型。收起时只有 id、上下文、折扣、起价;展开看进出价与能力。 */
function ModelRow() {
  return (
    <div class="mp-row" x-bind:class="$store.app.plazaOpen[m.id] ? 'open' : ''">
      <div class="mp-main" x-on:click="$store.app.togglePlazaModel(m.id)">
        <span class="mp-name" x-text="m.id"></span>
        <span class="mp-ctx" x-text="$store.app.fmtCtx(m.contextLimit)"></span>
        <span class="mp-off" x-show="m.discount > 0" x-text="$store.app.fmtDiscount(m.discount)"></span>
        <span class="mp-price" x-text="$store.app.fmtPrice(m)"></span>
      </div>

      <div class="mp-detail" x-show="$store.app.plazaOpen[m.id]" x-cloak>
        <div class="mp-meta">
          <span x-show="m.inputUsdPerMillion > 0">
            in
            {' '}
            <b x-text="'$' + m.inputUsdPerMillion.toFixed(2)"></b>
            {' · out '}
            <b x-text="'$' + m.outputUsdPerMillion.toFixed(2)"></b>
            {' / 1M tokens'}
          </span>
          <span x-show="!(m.inputUsdPerMillion > 0)" class="mp-dim">
            pricing unavailable
          </span>
          {/* 原价由「我们的价 ÷ 折扣系数」推出来 —— 只有一个数是真的,
              两个都发布迟早会对不上。 */}
          <span class="mp-was" x-show="m.discount > 0">
            list
            {' '}
            <s x-text="$store.app.fmtList(m)"></s>
          </span>
        </div>

        <div class="mp-meta">
          <span x-show="m.reasoning">reasoning</span>
          <span x-show="m.images">vision</span>
          <span x-text="'max out ' + $store.app.fmtCtx(m.maxOutputTokens)"></span>
          <span x-text="m.native === 'anthropic' ? 'anthropic native' : 'openai compatible'"></span>
        </div>
      </div>
    </div>
  )
}

export function ModelPlaza() {
  return (
    // 只在登录后出现 —— 未登录时给的是介绍页(见 welcome.tsx),
    // 三十个点不动的模型对没登录的人不是信息,是噪音。
    <section x-show="$store.app.state?.beatapi?.linked">
      <h3>
        <span>Models</span>
        <span class="h3-actions">
          <span class="mp-count" x-text="$store.app.plazaTotal + ' models'"></span>
          <button class="tiny" x-on:click="$store.app.refreshBeatapi()">Refresh</button>
        </span>
      </h3>

      <input
        class="mp-search"
        type="text"
        placeholder="Filter models…"
        x-model="$store.app.plazaQuery"
        x-on:input="$store.app.onPlazaQuery()"
      />

      <div x-show="$store.app.plazaLoading && $store.app.plazaTotal === 0" class="mp-empty">
        Loading the model catalogue…
      </div>
      <div x-show="!$store.app.plazaLoading && $store.app.plazaTotal === 0" class="mp-empty">
        Could not reach the BeatAPI catalogue.
      </div>

      <template x-for="group in $store.app.plazaGroups" x-bind:key="group.family">
        <div class="mp-group">
          <div class="mp-family" x-on:click="$store.app.togglePlazaFamily(group.family)">
            <span
              class="mp-caret"
              x-text="$store.app.plazaCollapsed[group.family] ? '▸' : '▾'"
            >
            </span>
            <span x-text="group.label"></span>
            <span class="mp-count" x-text="group.models.length"></span>
          </div>
          <template x-for="m in group.models" x-bind:key="m.id">
            <div x-show="!$store.app.plazaCollapsed[group.family]">
              <ModelRow />
            </div>
          </template>
        </div>
      </template>
    </section>
  )
}
