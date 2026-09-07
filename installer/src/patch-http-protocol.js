/**
 * Cursor HTTP 传输协议设置 —— 强制 Agent 流走 HTTP/1.1 + SSE。
 *
 * 为什么必须有这一步:
 *
 * Cursor 的 agent 流有三条传输路径,由 BidiTransportFactory.createTransport 选择:
 *
 *   useHttp2 === true                     → agent.v1.AgentService/Run     (bidi, HTTP/2)
 *   useHttp2 === false + SSE 未禁用        → agent.v1.AgentService/RunSSE  (server streaming)
 *   useHttp2 === false + SSE 已禁用        → agent.v1.AgentService/RunPoll (轮询)
 *
 * 而 useHttp2 = !isHttp2Disabled(),isHttp2Disabled() 读的就是
 * `cursor.general.disableHttp2`,默认 **false**。
 *
 * 我们把整条链路压成 HTTP/1.1(见 node-http11-router / patch-agent-host),
 * HTTP/1.1 跑不了全双工 bidi。所以默认设置下客户端会选 Run,
 * 请求打到本地 server 后在协议层就失败,客户端只看到:
 *
 *   ConnectError: [internal] Protocol error        ← 重试 3 次后
 *   "An unexpected error occurred on our servers"  ← UI 上的样子
 *
 * 本地 server 日志里 **一条记录都没有** —— 因为请求根本没进到 handler。
 * 这一点让它极难定位:面板、余额、模型列表全是好的,只有发消息失败。
 *
 * 所以安装时必须写死:
 *   cursor.general.disableHttp2    = true   (让它走降级路径)
 *   cursor.general.disableHttp1SSE ≠ true   (降到 SSE 而不是 Poll;
 *                                            RunPoll 不在 redirect 白名单里)
 *
 * 改动是热生效的 —— Cursor 侧有 onDidChangeHttpProtocolSettings 监听这两个键,
 * 变更时重建 transport,通常不需要重启。
 *
 * 实现上刻意 **不做 JSON 往返**:settings.json 是用户高频手改的文件,
 * 可能带注释和自定义格式,parse→stringify 会把它们抹掉。
 * 这里只做定点的文本替换 / 插入 / 删行。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { createBackup } from './backup.js';

const TAG = 'http-protocol';

export const HTTP2_SETTING = 'cursor.general.disableHttp2';
export const HTTP1_SSE_SETTING = 'cursor.general.disableHttp1SSE';

/** 用户 settings.json 路径(可用 CURSOR_USER_SETTINGS 覆盖,便于测试)。 */
export function getUserSettingsPath() {
  const override = process.env.CURSOR_USER_SETTINGS;
  if (override) return override;

  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor', 'User', 'settings.json');
  }
}

/** 顶层键的匹配式 —— 只认 true/false 字面量,别的值(变量/注释)交给人工处理。 */
function settingPattern(key) {
  return new RegExp(`("${key.replace(/\./g, '\\.')}"\\s*:\\s*)(true|false)`);
}

function readSettings(file) {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8');
  }
  catch {
    return null;
  }
}

/** 探测文件缩进 —— 取第一个缩进过的行,取不到则用 4 空格(Cursor 默认)。 */
function detectIndent(source) {
  const m = source.match(/\n([ \t]+)"/);
  return m ? m[1] : '    ';
}

function readBool(source, key) {
  const m = source.match(settingPattern(key));
  if (!m) return undefined;
  return m[2] === 'true';
}

/**
 * 当前设置是否已经能让 agent 流走 SSE。
 * 返回 { file, exists, http2Disabled, http1SseDisabled, ok }
 */
export function inspectHttpProtocolSettings() {
  const file = getUserSettingsPath();
  const source = readSettings(file);
  if (source === null) {
    return { file, exists: false, http2Disabled: undefined, http1SseDisabled: undefined, ok: false };
  }
  const http2Disabled = readBool(source, HTTP2_SETTING);
  const http1SseDisabled = readBool(source, HTTP1_SSE_SETTING);
  return {
    file,
    exists: true,
    http2Disabled,
    http1SseDisabled,
    // 两个键都取默认值 false 时 → useHttp2=true → bidi Run → Protocol error
    ok: http2Disabled === true && http1SseDisabled !== true,
  };
}

/** 在最外层 `{` 之后插入一个布尔键。 */
function insertSetting(source, key, value, indent) {
  const brace = source.indexOf('{');
  if (brace === -1) return null;
  const line = `\n${indent}"${key}": ${value},`;
  return source.slice(0, brace + 1) + line + source.slice(brace + 1);
}

/** 设成目标值 —— 已存在就改值,不存在就插入。 */
function applySetting(source, key, value, indent) {
  const pattern = settingPattern(key);
  if (pattern.test(source)) {
    return source.replace(pattern, `$1${value}`);
  }
  return insertSetting(source, key, value, indent);
}

/**
 * 写入设置。返回 { changed, skipped, reason }。
 *
 * settings.json 不存在时会创建一份最小文件 —— 全新装的 Cursor 就是这种情况。
 */
export function patchHttpProtocolSettings(log) {
  const file = getUserSettingsPath();
  const state = inspectHttpProtocolSettings();

  if (state.ok) {
    log?.('  HTTP/1.1 SSE transport already configured');
    return { changed: false, skipped: true, reason: 'already-configured' };
  }

  if (!state.exists) {
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    if (!existsSync(dir)) {
      log?.(`  Cursor user directory not found: ${dir}`);
      return { changed: false, skipped: true, reason: 'no-user-dir' };
    }
    writeFileSync(file, `{\n    "${HTTP2_SETTING}": true\n}\n`, 'utf-8');
    log?.(`  Created settings.json with ${HTTP2_SETTING}=true`);
    return { changed: true, skipped: false, reason: 'created' };
  }

  const source = readSettings(file);
  const indent = detectIndent(source);
  let next = source;

  if (state.http2Disabled !== true) {
    const applied = applySetting(next, HTTP2_SETTING, 'true', indent);
    if (applied === null) {
      log?.('  settings.json has no top-level object; skipped');
      return { changed: false, skipped: true, reason: 'unparsable' };
    }
    next = applied;
  }
  // 只有被显式设成 true 时才需要动它 —— 默认 false 正是我们要的。
  if (state.http1SseDisabled === true) {
    next = applySetting(next, HTTP1_SSE_SETTING, 'false', indent);
  }

  if (next === source) {
    return { changed: false, skipped: true, reason: 'no-op' };
  }

  createBackup(file, TAG, log);
  writeFileSync(file, next, 'utf-8');
  log?.(`  ${HTTP2_SETTING}=true (agent stream → HTTP/1.1 SSE)`);
  return { changed: true, skipped: false, reason: 'patched' };
}

/**
 * 移除我们写入的键。
 *
 * 刻意**不**整份还原备份 —— settings.json 是用户高频修改的文件,
 * 安装期间的其他改动不该被回滚掉。这里只删这两行,
 * 删完做一次 JSON 合法性校验;不合法就原样放回并警告。
 */
export function unpatchHttpProtocolSettings(log) {
  const file = getUserSettingsPath();
  const source = readSettings(file);
  if (source === null) return false;

  const lineOf = key => new RegExp(`^[ \\t]*"${key.replace(/\./g, '\\.')}"\\s*:\\s*(?:true|false)\\s*,?[ \\t]*\\r?\\n`, 'm');
  let next = source;
  for (const key of [HTTP2_SETTING, HTTP1_SSE_SETTING]) {
    next = next.replace(lineOf(key), '');
  }
  if (next === source) return false;

  try {
    JSON.parse(next);
  }
  catch {
    // 带注释的 settings.json 本来就 parse 不了 —— 这时不冒险改写。
    log?.('  settings.json is not plain JSON; left HTTP protocol settings in place');
    return false;
  }

  writeFileSync(file, next, 'utf-8');
  log?.(`  Removed ${HTTP2_SETTING} / ${HTTP1_SSE_SETTING}`);
  return true;
}
