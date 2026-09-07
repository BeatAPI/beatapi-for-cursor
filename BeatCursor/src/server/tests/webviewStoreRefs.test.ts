/**
 * 模板引用的每一个 store 成员都必须真的存在。
 *
 * 这条测试存在的理由是**Alpine 对不存在的成员完全静默** —— 不报错、不进控制台、
 * typecheck 和 lint 都过(模板是字符串,类型系统看不见里面),表现只是那一格
 * 渲染成空白。这个坑已经踩过两次:
 *
 *   1. 模板写 `fmtTokens`,实际方法叫 `fmtCtx` → 整列上下文空白;
 *   2. 模板引用 `usageTextSpend`,而装在机器上的 webview bundle 还是旧的
 *      → 三个统计格子只剩标签。
 *
 * 两次都是肉眼审查过、测试全绿之后才在真机上发现的。所以交给机器查。
 *
 * ⚠️ 模板和 store 是**两个独立打包的 bundle**(extension.js / webview.js),
 * 它们之间没有任何编译期约束,这条测试是唯一的约束。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const COMPONENTS_DIR = join(__dirname, '../../ui/components')
const APP_TS = join(__dirname, '../../ui/webview/app.ts')

/** 去掉注释 —— 注释里写 `$store.app.foo` 当例子是合法的,不该算引用。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

function templateRefs(): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  for (const file of readdirSync(COMPONENTS_DIR).filter(f => f.endsWith('.tsx'))) {
    const source = stripComments(readFileSync(join(COMPONENTS_DIR, file), 'utf-8'))
    for (const match of source.matchAll(/\$store\.app\.([A-Za-z_]\w*)/g)) {
      const name = match[1]
      if (!refs.has(name))
        refs.set(name, new Set())
      refs.get(name)!.add(file)
    }
  }
  return refs
}

/** store 对象的成员 —— 顶层缩进四格的属性与方法。 */
function storeMembers(): Set<string> {
  const source = stripComments(readFileSync(APP_TS, 'utf-8'))
  const members = new Set<string>()
  for (const match of source.matchAll(/^ {4}(?:async +|get +|\* *)?([A-Za-z_]\w*)\s*[:(]/gm))
    members.add(match[1])
  return members
}

it('every $store.app.* the templates read is defined on the store', () => {
  const refs = templateRefs()
  const defined = storeMembers()

  // 这两条断言本身也会腐坏:正则一旦匹配不到东西,测试会因为"没有引用"而
  // 假装通过。所以先确认两边都真的解析出了东西。
  expect(refs.size).toBeGreaterThan(20)
  expect(defined.size).toBeGreaterThan(20)

  const missing = [...refs.entries()]
    .filter(([name]) => !defined.has(name))
    .map(([name, files]) => `${name} (used in ${[...files].sort().join(', ')})`)

  expect(missing).toEqual([])
})
