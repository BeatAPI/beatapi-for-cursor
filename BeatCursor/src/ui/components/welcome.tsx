/**
 * 未登录时的介绍页。
 *
 * 之前这里直接摊开三十个模型,理由是"空面板不会让人想登录"。那个理由站不住:
 * 一个没登录的人看到三十个**点不动**的模型,得到的信息是"这东西复杂",
 * 而不是"我该登录"。他真正要知道的只有三件事 —— 这是什么、我能得到什么、
 * 从哪开始。所以模型清单挪到登录之后,这里只留这三件。
 *
 * 数字全部来自目录本身(匿名可取,未登录也有)。写死的卖点会烂:
 * 模型加到 35 个、折扣调过一轮之后,页面还在说 30 个,而没有人会记得回来改。
 */
export function Welcome() {
  return (
    <section class="wc" x-show="!$store.app.state?.beatapi?.linked">
      <p class="wc-lead">
        Use BeatAPI models directly inside Cursor — your account, your balance,
        your usage.
      </p>

      <ul class="wc-points">
        <li>
          <b x-text="$store.app.plazaTotal || '30'"></b>
          {' text models across '}
          <b x-text="$store.app.plazaFamilyCount || '12'"></b>
          {' families — Claude, GPT, Gemini, DeepSeek, Kimi, GLM and more'}
        </li>
        {/* 折扣区间是算出来的,拿不到数就整条不显示 —— 报一个编的折扣比不报更糟 */}
        <li x-show="$store.app.fmtDiscountRange()">
          {'Every model discounted — '}
          <b x-text="$store.app.fmtDiscountRange()"></b>
          {' off list price'}
        </li>
        <li>Pay per token. Balance and per-model usage live in this panel.</li>
      </ul>

      <button class="wc-cta" x-on:click="$store.app.post('beatapiSignIn')">
        Sign in with BeatAPI
      </button>

      <button class="wc-site" x-on:click="$store.app.post('beatapiOpenSite')">
        beatapi.io
      </button>
    </section>
  )
}
