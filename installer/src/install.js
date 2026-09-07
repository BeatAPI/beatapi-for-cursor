/**
 * beatcursor install — 完整安装流程
 *
 * 顺序：
 *   0. 定位 Cursor 安装目录 + 预检
 *   1. 释放默认配置到 ~/.beatcursor/
 *   2. 安装扩展到 extensions/beatcursor/
 *   3. 注入 renderer hook (workbench.js)
 *   4. 注入 always-local 拦截 + 签名绕过 + 优先加载 (extensionHostProcess.js)
 *   5. 注入 cursor-agent-host 独立 HTTP/1.1 transport 拦截并禁用 WebSocket
 *   6. Cursor 3.9+ always-local singleton BYOK router + HTTP/1.1 proxy 修补
 *   7. KaTeX CSS link 修补 (workbench.html)
 *   8. 提示重启
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { installExtension, isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { isInjectPatched, patchInject } from './patch-inject.js';
import { inspectAlwaysLocalPatch, patchAlwaysLocal } from './patch-always-local.js';
import { getAgentHostBackupTargets, isAgentHostPatched, patchAgentHost } from './patch-agent-host.js';
import { patchKatex } from './patch-katex.js';
import { patchProxy39, needsProxy39Patch, isProxy39Patched } from './patch-proxy-39.js';
import { inspectHttpProtocolSettings, patchHttpProtocolSettings } from './patch-http-protocol.js';
// delete-fix 已移除 — 3.2.11 原生 tombstoneDeletedComposer 已覆盖
import { releaseDefaults } from './release-defaults.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function install() {
  info('BeatCursor Installer');
  console.log('');

  // 0. 定位 + 预检
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);
  info(`Version: ${paths.cursorVersion}${paths.hasGlass ? ' (glass)' : ''}`);

  const extInstalled = isExtensionInstalled(paths);
  const desktopPatched = existsSync(paths.workbenchJs) && isInjectPatched(readFileSync(paths.workbenchJs, 'utf-8'));
  const glassPatched = !existsSync(paths.glassJs) || isInjectPatched(readFileSync(paths.glassJs, 'utf-8'));
  const hookInjected = desktopPatched && glassPatched;
  const alPatched = inspectAlwaysLocalPatch(paths).fullyPatched;
  const agentHostPatched = isAgentHostPatched(paths);
  const proxy39Ok = !needsProxy39Patch(paths) || isProxy39Patched(paths);
  const agentHostBackups = getAgentHostBackupTargets(paths).some(file => hasBackup(file, 'agent-host'));
  const hasBackups = hasBackup(paths.workbenchJs) || hasBackup(paths.glassJs) || hasBackup(paths.alwaysLocalMain)
    || hasBackup(paths.alwaysLocalSingletonJs) || hasBackup(paths.extensionHostJs) || agentHostBackups;

  if (extInstalled && hookInjected && alPatched && agentHostPatched && proxy39Ok) {
    // 二进制补丁齐了不代表能用 —— 传输协议设置是独立的一环,
    // 缺了它 agent 流会选 bidi Run 并在协议层失败。这里就地自愈。
    if (!inspectHttpProtocolSettings().ok) {
      info('Repairing HTTP transport settings...');
      patchHttpProtocolSettings(info);
      console.log('');
      ok('Already installed; transport settings repaired');
      return;
    }
    ok('Already fully installed');
    info('To reinstall, run "beatcursor uninstall" first');
    return;
  }

  if (hasBackups && !extInstalled) {
    warn('Found backup files from a previous installation');
    warn('Run "beatcursor uninstall" to clean up before reinstalling');
    return;
  }

  console.log('');

  // 1. 释放默认配置到 ~/.beatcursor/ (尊重已有用户文件)
  releaseDefaults(info);

  // 2. 安装扩展
  installExtension(paths, info);

  // 3. Inject renderer hook
  patchInject(paths, info);

  // 4. Always-local + sig bypass
  patchAlwaysLocal(paths, info);

  // 5. Independent Agent Host transport (3.13+)
  patchAgentHost(paths, info);

  // 6. Cursor 3.9+ always-local singleton BYOK router + HTTP/1.1 proxy sync
  patchProxy39(paths, info);

  // 7. KaTeX CSS link (workbench.html + checksum)
  patchKatex(paths, info);

  // 8. 强制 agent 流走 HTTP/1.1 SSE —— 默认设置下客户端选 bidi Run,
  //    在我们压成 HTTP/1.1 的链路上必然 Protocol error。
  patchHttpProtocolSettings(info);

  console.log('');
  ok('Installation complete!');
  warn('Restart Cursor for changes to take effect.');
  info('Uninstall: npx beatcursor uninstall');
}
