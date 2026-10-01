#!/usr/bin/env node
/**
 * 在 clone 出来的仓库里重建测试替身。
 *
 * 为什么需要：`test/node_modules/@deepseek-ai/{dsh-tools,schemastery}` 是让
 * `createTool()` 能在 DSH 之外被调用的最小替身，而 `node_modules/` 被 `.gitignore`
 * 排除、也不会进包。所以 clone 之后跑一次本脚本，把它们接回插件根，
 * `npm test` 才能工作。
 *
 * 做法：优先建 junction（Windows，无需管理员），失败则退回目录符号链接；
 * 两者都不行（权限受限）时给出明确的手动指令。
 *
 * 用法：node tools/make-test-stubs.mjs
 */

import { mkdir, symlink, lstat, rm, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SOURCE = join(ROOT, 'test', 'node_modules', '@deepseek-ai')
const TARGET = join(ROOT, 'node_modules', '@deepseek-ai')

try {
  await access(SOURCE)
} catch {
  console.error(`找不到测试替身目录：${SOURCE}`)
  console.error('它应该随仓库一起存在（test/node_modules/@deepseek-ai/）。')
  process.exit(1)
}

await mkdir(join(ROOT, 'node_modules'), { recursive: true })
try {
  const existing = await lstat(TARGET)
  if (existing.isSymbolicLink()) await rm(TARGET, { force: true })
  else {
    console.log(`${TARGET} 已存在且不是链接，保持原样。`)
    process.exit(0)
  }
} catch {
  /* 不存在，继续创建 */
}

for (const type of ['junction', 'dir']) {
  try {
    await symlink(SOURCE, TARGET, type)
    console.log(`已创建 ${type === 'junction' ? 'junction' : '符号链接'}：${TARGET} -> ${SOURCE}`)
    console.log('现在可以运行：npm test')
    process.exit(0)
  } catch (error) {
    if (type === 'dir') {
      console.error(`创建链接失败：${error.message}`)
      console.error('手动方案（任选其一）：')
      console.error(`  1. 以管理员或开启开发者模式后重试`)
      console.error(`  2. 直接把 ${SOURCE} 复制成 ${TARGET}`)
      process.exit(1)
    }
  }
}
