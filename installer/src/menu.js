/**
 * 交互菜单 —— `npx beatcursor` 不带参数时进这里。
 *
 * 为什么要有它:装这个东西的人不是来记命令的。带参数的子命令一个都没动,
 * 一键脚本和 CI 照旧调 `beatcursor install`;菜单只是给**人**的那一层。
 *
 * ⚠️ 只在真的连着终端时才进菜单。管道里、CI 里、`| tee` 后面都没有 TTY,
 * 那时读键盘会直接挂起,一个本该秒退的命令变成永远不返回 —— 所以非 TTY
 * 一律退回打印帮助。
 *
 * 刻意不引任何依赖(inquirer 之类)。这个包会被 `npx` 拉起,
 * 每多一个依赖就多一份下载和一处供应链风险,而这里要的不过是
 * 方向键和一块高亮。
 */
import { emitKeypressEvents } from 'node:readline';
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed } from './detect.js';
import { isExtensionInstalled } from './extension-embed.js';
import { inspectAlwaysLocalPatch } from './patch-always-local.js';
import { isAgentHostPatched } from './patch-agent-host.js';
import { isInjectPatched } from './patch-inject.js';
import { inspectHttpProtocolSettings } from './patch-http-protocol.js';

const ESC = '\x1b';
const BRAND = `${ESC}[38;2;18;88;255m`; // 品牌蓝 rgb(18,88,255),取自标志主干
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;

/**
 * 标志点阵 —— 四列,第一列是贯通的主干,其余三列在中间断开。
 *
 * 那个缺口就是这个标志的辨识点(见 BeatCursor 里的内联 SVG:主干 y=52..971
 * 连续,其余三列各自分成上下两段),所以行数宁可多一行也要把它留出来。
 */
const LOGO_ROWS = [
  [1, 1, 0, 0],
  [1, 1, 1, 0],
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [1, 0, 0, 0],
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [1, 1, 1, 0],
];

function renderLogo(lines) {
  const out = [];
  for (let i = 0; i < LOGO_ROWS.length; i++) {
    const row = LOGO_ROWS[i];
    let art = '  ';
    for (let col = 0; col < row.length; col++) {
      // 主干上色,其余跟终端前景走 —— 深色浅色主题下都读得出来
      art += row[col] ? `${col === 0 ? BRAND : ''}██${RESET} ` : '   ';
    }
    out.push(`${art}  ${lines[i] || ''}`);
  }
  return out.join('\n');
}

/** 读一眼当前装成什么样了 —— 菜单顶上那几行状态。 */
function probe() {
  const { paths } = findCursorPathsDetailed();
  if (!paths)
    return { found: false };

  const extInstalled = isExtensionInstalled(paths);
  const desktopOk = existsSync(paths.workbenchJs) && isInjectPatched(readFileSync(paths.workbenchJs, 'utf-8'));
  const glassOk = !existsSync(paths.glassJs) || isInjectPatched(readFileSync(paths.glassJs, 'utf-8'));
  const alwaysLocal = inspectAlwaysLocalPatch(paths);
  const patched = desktopOk && glassOk && alwaysLocal.fullyPatched && isAgentHostPatched(paths);
  const transport = inspectHttpProtocolSettings();

  return {
    found: true,
    appRoot: paths.appRoot,
    cursorVersion: paths.cursorVersion,
    extInstalled,
    patched,
    // 二进制补丁齐了不代表能用:传输协议设置是独立的一环,缺了它
    // agent 流会选 HTTP/2 bidi,在被压成 HTTP/1.1 的链路上必然失败。
    transportOk: transport.ok,
  };
}

function statusLines(st, version) {
  if (!st.found) {
    return [
      `${BOLD}BeatCursor${RESET}  ${DIM}v${version}${RESET}`,
      `${DIM}BeatAPI client for Cursor${RESET}`,
      '',
      `${RED}Cursor not found${RESET}`,
      `${DIM}Install Cursor first, or set${RESET}`,
      `${DIM}BEATCURSOR_CURSOR_ROOT${RESET}`,
    ];
  }

  let state;
  if (!st.extInstalled)
    state = `${DIM}not installed${RESET}`;
  else if (st.patched && st.transportOk)
    state = `${GREEN}installed${RESET}`;
  else if (st.patched)
    state = `${YELLOW}installed, transport not configured${RESET}`;
  else
    state = `${YELLOW}partially installed${RESET}`;

  return [
    `${BOLD}BeatCursor${RESET}  ${DIM}v${version}${RESET}`,
    `${DIM}BeatAPI client for Cursor${RESET}`,
    '',
    `Cursor   ${st.cursorVersion || 'unknown'}`,
    `Status   ${state}`,
  ];
}

function buildItems(st) {
  const installed = Boolean(st.found && st.extInstalled);
  return [
    {
      id: 'install',
      label: 'Install',
      hint: 'Install the extension and patch Cursor',
      disabled: !st.found || installed,
      // 已经装了还显示 Install 会让人以为没装上,所以直接说清楚
      disabledNote: installed ? 'already installed' : 'Cursor not found',
    },
    {
      id: 'update',
      label: 'Reinstall / Upgrade',
      hint: 'Restore originals, then install this version',
      disabled: !st.found,
      disabledNote: 'Cursor not found',
    },
    {
      id: 'uninstall',
      label: 'Uninstall',
      hint: 'Remove the extension and restore every patched file',
      disabled: !st.found || !installed,
      disabledNote: installed ? 'Cursor not found' : 'nothing installed',
    },
    { id: 'status', label: 'Status', hint: 'Show the full installation report' },
    { id: 'quit', label: 'Quit', hint: '' },
  ];
}

function draw(items, cursor, st, version) {
  const out = [];
  out.push('');
  out.push(renderLogo(statusLines(st, version)));
  out.push('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const selected = i === cursor;
    const marker = selected ? `${BRAND}❯${RESET}` : ' ';
    let label = item.disabled ? `${DIM}${item.label}${RESET}` : item.label;
    if (selected && !item.disabled)
      label = `${BOLD}${label}${RESET}`;
    const note = item.disabled && item.disabledNote ? `  ${DIM}(${item.disabledNote})${RESET}` : '';
    out.push(`  ${marker} ${label}${note}`);
  }

  out.push('');
  const active = items[cursor];
  out.push(`  ${DIM}${active && !active.disabled ? active.hint : ''}${RESET}`);
  out.push('');
  out.push(`  ${DIM}↑↓ move   enter select   q quit${RESET}`);
  out.push('');
  return out.join('\n');
}

function clear() {
  // 清屏 + 光标回左上。不用 console.clear():它在部分终端里只是滚屏,
  // 上一轮的菜单会留在上面,看起来像画了两遍。
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

/** 等一次回车,让用户看完输出再回菜单。 */
function pause(prompt = 'Press enter to return to the menu…') {
  return new Promise((resolve) => {
    process.stdout.write(`\n  ${DIM}${prompt}${RESET}`);
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes('\r') || s.includes('\n')) {
        process.stdin.off('data', onData);
        resolve();
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * 跑一个动作。
 *
 * 动作自己会往 stdout 写,所以先退出 raw mode 再交出去 —— 否则它们打印的
 * 换行不会回到行首,输出看着像被砍掉了左边。
 */
async function runAction(fn) {
  const wasRaw = process.stdin.isRaw;
  if (wasRaw)
    process.stdin.setRawMode(false);
  process.stdin.pause();

  clear();
  let failed = null;
  try {
    await fn();
  }
  catch (err) {
    failed = err;
    console.error(`\n${RED}[ERROR]${RESET} ${err.message}`);
  }

  process.stdin.resume();
  await pause();
  if (process.stdin.isTTY)
    process.stdin.setRawMode(true);
  return failed;
}

export async function menu(actions, version) {
  const items0 = buildItems(probe());
  let cursor = items0.findIndex(i => !i.disabled);
  if (cursor < 0)
    cursor = 0;

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let running = true;
  let st = probe();
  let items = buildItems(st);

  const render = () => {
    clear();
    process.stdout.write(draw(items, cursor, st, version));
  };

  const cleanup = () => {
    running = false;
    process.stdin.off('keypress', onKey);
    if (process.stdin.isTTY)
      process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  function moveTo(dir) {
    // 跳过不可用项 —— 停在一个按了没反应的条目上只会让人以为程序卡了
    for (let step = 1; step <= items.length; step++) {
      const next = (cursor + dir * step + items.length * step) % items.length;
      if (!items[next].disabled) {
        cursor = next;
        return;
      }
    }
  }

  let busy = false;
  async function onKey(_str, key) {
    if (!key || busy)
      return;

    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.stdout.write('\n');
      process.exit(130); // 128 + SIGINT,shell 脚本按这个判断是用户中断
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      moveTo(-1);
      render();
      return;
    }
    if (key.name === 'down' || key.name === 'j') {
      moveTo(1);
      render();
      return;
    }
    if (key.name === 'q' || key.name === 'escape') {
      cleanup();
      process.stdout.write('\n');
      process.exit(0);
      return;
    }
    if (key.name !== 'return' && key.name !== 'space')
      return;

    const item = items[cursor];
    if (!item || item.disabled)
      return;

    if (item.id === 'quit') {
      cleanup();
      process.stdout.write('\n');
      process.exit(0);
      return;
    }

    busy = true;
    await runAction(actions[item.id]);
    // 动作改变了世界,状态必须重读 —— 装完还显示"未安装"比不显示更糟
    st = probe();
    items = buildItems(st);
    if (items[cursor]?.disabled)
      moveTo(1);
    busy = false;
    if (running)
      render();
  }

  process.stdin.on('keypress', onKey);
  render();

  // 菜单靠 process.exit 退出,这里挂住事件循环
  await new Promise(() => {});
}
