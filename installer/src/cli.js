/**
 * beatcursor CLI — BeatCursor Installer
 *
 * Usage:
 *   npx beatcursor             # Interactive menu (only when attached to a TTY)
 *   npx beatcursor install     # Install extension + apply patches
 *   npx beatcursor uninstall   # Remove extension + restore patches
 *   npx beatcursor status      # Check installation status
 *
 * 子命令是**脚本接口**,一键安装脚本和 CI 都走它,行为和退出码不随菜单改变。
 * 菜单只在不带参数且连着终端时出现。
 */

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { status } from './status.js';
import { check } from './check.js';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { patchLocalMode } from './patch-local-mode.js';
import { restoreBackup } from './backup.js';
import { menu } from './menu.js';

async function update() {
  await uninstall();
  console.log('');
  await install();
}

const command = process.argv[2];

const commands = {
  install,
  uninstall,
  update,
  upgrade: update,
  status,
  check,
  'local-mode': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    patchLocalMode(paths, info);
  },
  'local-mode-off': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    info('Restoring local-mode patches...');
    let restored = 0;
    const { join } = await import('path');
    const targets = [
      'out/main.js',
      'out/vs/workbench/workbench.desktop.main.js',
      'out/vs/workbench/workbench.glass.main.js',
      'out/vs/workbench/api/node/extensionHostProcess.js',
      'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js',
    ];
    for (const rel of targets) {
      if (restoreBackup(join(paths.appRoot, rel), 'local-mode', info)) restored++;
    }
    if (restoreBackup(paths.productJson, 'local-mode', info)) restored++;
    console.log(restored > 0 ? `\x1b[32m[OK]\x1b[0m Restored ${restored} file(s)` : '\x1b[33m[!]\x1b[0m No backups found');
  },
  help: async () => {
    console.log(`
beatcursor — BeatCursor Installer

Run with no arguments in a terminal to open the interactive menu.
Subcommands are the scripting interface — use them from install scripts and CI.

Commands:
  install          Install BeatAPI extension and apply patches
  uninstall        Remove extension and restore all patches
  update           Upgrade: uninstall then reinstall
  local-mode       Standalone tool: enable Cursor's built-in Local Agent mode
  local-mode-off   Standalone tool: disable Local Agent mode (restore originals)
  status           Check current installation status
  check            Dry-run: verify AST patch targets are matchable
  help             Show this help message
`);
  },
};

// 顶层 await 在 CJS 输出里不可用(esbuild: format=cjs, target=node18),
// 所以入口包成一个 async 函数,不要直接 await。
async function main() {
  // 不带参数:有终端就开菜单,没有就打印帮助并成功退出。
  //
  // ⚠️ 非 TTY 时**绝不能**进菜单。管道、CI、`curl … | sh` 里都没有键盘,
  // 读键会永远挂着 —— 一个本该秒退的命令变成挂死的进程。
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await menu({ install, uninstall, update, status }, process.env.BEATCURSOR_VERSION || '');
      return;
    }
    await commands.help();
    return;
  }

  const fn = commands[command];
  if (!fn) {
    console.error(`Unknown command: ${command}`);
    await commands.help();
    process.exit(1);
  }
  await fn();
}

main().catch(err => {
  console.error(`\n\x1b[31m[ERROR]\x1b[0m ${err.message}`);
  process.exit(1);
});
