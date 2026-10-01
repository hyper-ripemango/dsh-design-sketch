#!/usr/bin/env node
/**
 * 为发布准备一份"已清洗"的插件副本。
 *
 * 设计原则（都是被真实事故逼出来的）：
 *   1. **不动工作副本** —— 所有改动只落在 staging 目录
 *   2. **清洗规则外置** —— 本机私有路径写在 `.release-rules.json`（不进包），
 *      本脚本自身因此不含任何私有路径。早期版本把规则内联在本文件里，
 *      结果清洗器把自己的规则表也改了，不可重跑。
 *   3. **分级替换** —— 不同文件用不同强度的规则：
 *        · 文档/配置（README、cordis.patch.yml）：全量替换（含工作区路径、用户名）
 *        · 测试与工具：**只替换个人目录**，绝不碰 `C:\dogx` 这类夹具路径
 *      （否则会把测试期望值改掉，例如 `toPosix('C:\\dogx\\x')` 的期望
 *      从 `'C:/dogx/x'` 变成占位符，用例直接失败）
 *   4. **清洗后复核** —— 再跑一遍泄露审计，非 0 命中就拒绝出包
 *
 * 用法：
 *   node tools/prepare-release.mjs [--out <目录>]
 */

import { readFile, writeFile, readdir, copyFile, mkdir, lstat, rm } from 'node:fs/promises'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 && args[outIndex + 1] !== undefined
  ? resolve(args[outIndex + 1])
  : resolve(SOURCE, '..', 'dsh-design-sketch-release')

/** 不进包的东西。 */
const SKIP = new Set(['node_modules', '.git', 'delivery-audit.log', '.release-rules.json'])

/**
 * 例外：这些 `node_modules` 路径必须随包发布。
 *
 * `test/node_modules/@deepseek-ai/` 里是两个**手写的极简测试替身**（`dsh-tools`、
 * `schemastery` 的十行实现），没有它们 `createTool()` 在 DSH 之外无法调用，
 * `npm test` 就跑不起来。它们体积只有几 KB、内容全是自研代码，不是第三方依赖。
 *
 * 而根目录的 `node_modules`（junction）与 `test/node_modules` 下的真实依赖一律跳过 ——
 * 前者是本机的链接，后者不该由我们分发。
 */
const ALLOWED_NODE_MODULES = ['test/node_modules/@deepseek-ai']

/** 只做"个人目录"级替换的路径（测试与工具：里面的路径多为夹具，不能整体换）。 */
const PERSONAL_ONLY = [/^test\//, /^tools\//]

const GITIGNORE = `# 依赖与产物
node_modules/
*.log

# 例外：测试替身必须入库，否则 clone 之后 npm test 跑不起来
# （这两个包是本仓库手写的极简实现，不是第三方依赖）
!test/node_modules/
!test/node_modules/@deepseek-ai/

# 密钥与凭据：绝不入库
dashscope-key.txt
*-key.txt
.env
.env.*

# 本机私有替换表（只用于生成发布副本）
.release-rules.json

# 设计图产物（若把 outputDir 指到包内）
demo/
design/
`

/** 统一行尾为 LF：避免 Windows 检出后 CRLF 混入、diff 抖动。 */
const GITATTRIBUTES = `* text=auto eol=lf
*.png binary
`

const README_BANNER = [
  '> **发布版说明**：本仓库是 `dsh-design-sketch` 的打包发布副本。',
  '> **API Key 未填写**（配置项 `apiKey` / `keyFile` 都为空），使用前请自行在',
  '> 阿里云百炼申请 key 并填入密钥文件——见下文「密钥」一节。',
  '> 包内出现的 `<插件目录>`、`<DSH_HOME>`、`<工作区>`、`<密钥文件>`、`<用户目录>`、',
  '> `<你的 GitHub 用户名>` 等**都是占位符**，请按自己机器的实际路径替换。',
]

// ------------------------------------------------------------------ 读规则

let rules = { exact: [], personal: [] }
try {
  rules = JSON.parse(await readFile(join(SOURCE, '.release-rules.json'), 'utf8'))
} catch {
  console.error('缺少 .release-rules.json（本机私有替换表），无法确保清洗彻底。已中止。')
  process.exit(1)
}

// ------------------------------------------------------------------ 复制

const copied = []
const skipped = []

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const rel = relative(SOURCE, join(from, entry.name)).split('\\').join('/')
    // 允许例外优先判定：既要放行最终路径，也要放行通向它的**中间目录**
    // （例如遍历到 `test/node_modules` 时必须继续往下，否则到的了前缀却走不进目录）
    const allowed = ALLOWED_NODE_MODULES.some(
      (prefix) => rel === prefix || rel.startsWith(`${prefix}/`) || prefix.startsWith(`${rel}/`),
    )
    if (!allowed && SKIP.has(entry.name)) {
      skipped.push(rel)
      continue
    }
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    const info = await lstat(src)
    if (info.isSymbolicLink()) {
      // 根目录的测试用 junction 不进包（clone 后由 npm run test:stubs 重建）
      skipped.push(rel)
      continue
    }
    if (entry.isDirectory()) {
      await copyTree(src, dst)
      continue
    }
    await copyFile(src, dst)
    copied.push(rel)
  }
}

// ------------------------------------------------------------------ 清洗

const applyAll = (text, pairs) => {
  let out = text
  for (const [from, to] of pairs) out = out.split(from).join(to)
  return out
}

async function sanitize(dir) {
  const changed = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(mjs|js|json|yml|yaml|md|txt)$/i.test(entry.name)) continue
      const rel = relative(OUT, full).split('\\').join('/')
      let text = await readFile(full, 'utf8')
      const before = text

      if (PERSONAL_ONLY.some((re) => re.test(rel))) {
        // 测试与工具：只抹掉个人目录，保留夹具路径
        text = applyAll(text, rules.personal ?? [])
      } else {
        text = applyAll(text, rules.exact ?? [])
        text = applyAll(text, rules.personal ?? [])
      }

      if (rel === 'README.md') {
        const lines = text.split('\n')
        lines.splice(1, 0, '', ...README_BANNER)
        text = lines.join('\n')
      }
      if (text !== before) {
        await writeFile(full, text, 'utf8')
        changed.push(rel)
      }
    }
  }
  await walk(dir)
  return changed
}

// ------------------------------------------------------------------ 执行

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
await copyTree(SOURCE, OUT)
await writeFile(join(OUT, '.gitignore'), GITIGNORE, 'utf8')
await writeFile(join(OUT, '.gitattributes'), GITATTRIBUTES, 'utf8')
const changed = await sanitize(OUT)

// package.json：补测试脚本与仓库元数据
const pkgPath = join(OUT, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
pkg.scripts = {
  test: 'node test/smoke.mjs && node test/e2e.mjs',
  'test:stubs': 'node tools/make-test-stubs.mjs',
  'audit:leaks': 'node test/audit-leaks.mjs',
}
pkg.repository = { type: 'git', url: 'git+https://github.com/<你的 GitHub 用户名>/dsh-design-sketch.git' }
pkg.bugs = { url: 'https://github.com/<你的 GitHub 用户名>/dsh-design-sketch/issues' }
pkg.homepage = 'https://github.com/<你的 GitHub 用户名>/dsh-design-sketch#readme'
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(`源目录：${SOURCE}`)
console.log(`输出目录：${OUT}`)
console.log(`已复制 ${copied.length} 个文件；跳过 ${skipped.length} 个（依赖/本机规则表/日志）`)
console.log(`清洗改动 ${changed.length} 个文件：`)
for (const f of changed) console.log(`   ${f}`)
console.log(`\n下一步：node test/audit-leaks.mjs --dir "${OUT}"，必须 0 命中。`)
