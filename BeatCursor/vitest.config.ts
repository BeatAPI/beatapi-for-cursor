import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 这几个用例要 `@vscode/sqlite3` —— 那是 **Cursor 自己带的原生模块**,由宿主
 * app 提供,不在我们的 node_modules 里(见 server/database/sqlite.ts 的加载链)。
 *
 * 没装 Cursor 的机器 —— CI runner、别人 clone 下来的开发机 —— 一定加载失败。
 * 那不是回归,是环境不具备;让它红着的代价是一套**常年红的测试**,
 * 而常年红的测试等于没有测试,真回归混在里面没人看得见。
 *
 * 所以按环境跳过,并在跳过时明确说一声,免得有人以为这些用例根本不存在。
 */
const CURSOR_DEPENDENT_TESTS = [
  'src/server/tests/agentOrchestrator.integration.test.ts',
  'src/server/tests/autoSummarize.test.ts',
  'src/server/tests/providerRuntime.test.ts',
  'src/server/tests/chatSummary.test.ts',
]

function hasCursorSqlite(): boolean {
  const home = homedir()
  const roots = [
    process.env.CURSOR_APP_ROOT,
    '/Applications/Cursor.app/Contents/Resources/app',
    join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app'),
    '/usr/share/cursor/resources/app',
    '/opt/Cursor/resources/app',
    join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app'),
  ].filter((r): r is string => Boolean(r))

  return roots.some(root => existsSync(join(root, 'node_modules', '@vscode', 'sqlite3', 'package.json')))
}

const skipCursorTests = !hasCursorSqlite()
if (skipCursorTests) {
  console.warn(
    `[vitest] Cursor's @vscode/sqlite3 is not available — skipping ${CURSOR_DEPENDENT_TESTS.length} host-dependent integration tests.`,
  )
}

export default defineConfig({
  test: {
    include: ['src/server/tests/**/*.test.ts'],
    exclude: [
      'src/test/**',
      'dist/**',
      'node_modules/**',
      ...(skipCursorTests ? CURSOR_DEPENDENT_TESTS : []),
    ],
    // 全局 setup: 注入合成 providers,让所有测试里出现的 modelId
    // 都能命中 providersStore 反向索引 (不再走静默 anthropic fallback)。
    setupFiles: ['src/server/tests/setup.ts'],
  },
})
