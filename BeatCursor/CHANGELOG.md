# Change Log

BeatCursor —— BeatAPI 的 Cursor 客户端。

格式参考 [Keep a Changelog](http://keepachangelog.com/)。

## [0.0.15]

### 新增

- **BeatAPI 授权登录**。浏览器授权 + 本地回环回调(RFC 8252 §7.3),
  口令与二次验证全程留在浏览器里,扩展只收下一把中继 key。
- **模型广场**。匿名可取,未登录也是满的;按家族折叠,带零售价与折扣。
- **使用日志**。按文本模型的花费与调用次数,来自 `GET /v1/usage`。
- **充值快捷键** `⌘⌥B`,**余额与用量** `⌘⌥U`。
- 面板显示当前登录的账号名。

### 变更

- 模型清单改由网关的 `GET /v1/text/models` 提供,上下文、输出上限与价格
  在网关侧改完约 60 秒生效,客户端不用发版。
- 目录里的模型默认全部启用,不再需要在设置里逐个打开。
- 界面文案不再使用 "BYOK" 这一术语,改用「路由到 BeatAPI / Cursor」。

### 修复

- **Agent 流发不出消息**。Cursor 默认走 HTTP/2 bidi(`AgentService/Run`),
  而本地链路是 HTTP/1.1,跑不了全双工,请求在协议层就失败,
  界面上表现为 "An unexpected error occurred on our servers"。
  安装器现在会设置 `cursor.general.disableHttp2`,把流降级到 `RunSSE`。
- 使用日志不再列出生图/视频模型 —— 那是同一账号在别处花的钱。
