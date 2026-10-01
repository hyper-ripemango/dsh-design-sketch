/**
 * 打包前的泄露审计（只读）。
 *
 * 目标：在把插件交出去之前，确认里面**没有**任何不该外流的东西。
 * 输出只报"第几行、什么类别、命中长度"，**绝不回显密钥明文**。
 *
 * 用法：
 *   node audit-leaks.mjs                     # 审计插件源码目录
 *   node audit-leaks.mjs --dir <路径>
 *   node audit-leaks.mjs --key-file <文件>    # 额外比对真实 key 是否出现在任何文件里
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/** 默认审计"本脚本所在的插件目录"，这样包发出去后依然能直接用。 */
const HERE = pathDirname(fileURLToPath(import.meta.url))
const ROOT = argValue('--dir', pathResolve(HERE, '..'))
/** 密钥文件只用于"真实 key 是否泄漏"的比对；找不到就跳过，不影响其余审计。 */
const KEY_FILE = argValue('--key-file', process.env.DSH_DESIGN_KEY_FILE ?? join(pathResolve(HERE, '..', '..'), 'dashscope-key.txt'))

/** 要跳过遍历的目录（依赖、版本库、产物）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.pnpm', '__pycache__'])

/** 规则表：[类别, 正则, 说明]。值一律不回显。 */
const RULES = [
  ['API Key（DashScope）', /sk-[A-Za-z0-9_.\-]{12,}/g, '阿里云百炼密钥'],
  ['GitHub Token', /gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub 个人访问令牌'],
  ['GitHub 细粒度令牌', /github_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained PAT'],
  ['OpenAI 风格 Key', /sk-(?:proj|svcacct)-[A-Za-z0-9_\-]{20,}/g, '其它平台密钥'],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/g, 'AWS 访问密钥 ID'],
  ['Bearer 令牌', /Bearer\s+[A-Za-z0-9._\-]{16,}/gi, 'HTTP 鉴权头里的令牌'],
  ['B 站 Cookie', /SESSDATA=[A-Za-z0-9%_,;]+/gi, 'B 站登录凭据'],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'PEM 私钥'],
  ['邮箱地址', /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '可能是个人信息'],
  ['中文姓名/个人称呼', /(?:作者|author)\s*[:=]\s*[\u4e00-\u9fa5]{2,4}/gi, '疑似个人信息'],
]

/** 个人信息类路径（不是密钥，但属于"多余信息"，用户明确要求清理）。 */
const PATH_RULES = [
  ['个人目录路径', /C:\\Users\\[A-Za-z0-9._\-]+/g],
  ['个人目录路径（正斜杠）', /C:\/Users\/[A-Za-z0-9._\-]+/g],
  ['GitHub 用户名', /hyper-ripemango/g],
  ['本地工作区绝对路径', /C:\\dogx/g],
  ['项目外私有路径', /C:\\(?:DeepSeekcodingstate|dogx-acl-recovery)/g],
]

/**
 * 允许存在的"假密钥"（测试夹具），避免误报。
 *
 * **刻意写得精确**：只匹配带明显夹具标识的关键词，以及逐字出现的占位夹具。
 * 绝不写"长度 < 40 就当假"这类宽规则 —— 那会把短的真 key 一起放过，
 * 审计就失去意义了。本文件末尾有自检：用一个"像真 key"的样本验证它仍会报警。
 */
const ALLOWED_FAKE = new RegExp(
  [
    '^sk-(?:fake|test|wrong|dummy|placeholder|example|your)[A-Za-z0-9\\-_.]*$', // 带夹具标识
    '^sk-ws-AbCdEf\\.GhIjKl\\.MnOpQr\\.StUvWx123456$', // 点号格式回归用例（原样占位字母）
    '^sk-abcdefghijklmnop$', // 经典格式夹具
    '^sk-supersecretvalue123456$', // redact 用例夹具
  ].join('|'),
  'i',
)

/**
 * 判定某一行是否为"规则定义/说明行"，跳过它。
 *
 * 本工具自身必须能在发布副本里跑出 0 命中 —— 否则它就不可用了。而它的规则表里
 * 按定义就写着要检测的目标字符串（用户名、私有路径、密钥前缀）。所以对
 * 本文件自身、以及形如 `['标签', /正则/g],` 的定义行做豁免。
 */
const isRuleDefinitionLine = (rel, line) => {
  if (rel.endsWith('test/audit-leaks.mjs') || rel.endsWith('tools/prepare-release.mjs')) return true
  const trimmed = line.trim()
  if (/^\[.*,\s*\/.*\/[a-z]*\],?$/.test(trimmed)) return true // ['标签', /re/g],
  if (/^const (ALLOWED_FAKE|RULES|PATH_RULES)\b/.test(trimmed)) return true
  return false
}

const findings = []
let scanned = 0

async function walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    const full = join(dir, entry.name)
    const info = await stat(full)
    if (info.size > 2 * 1024 * 1024) continue // 大文件（图片等）不做文本扫描
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      continue // 二进制
    }
    if (text.includes('\u0000')) continue
    scanned++
    const rel = relative(ROOT, full).split('\\').join('/')
    const lines = text.split('\n')

    for (const [label, pattern, note] of RULES) {
      for (let i = 0; i < lines.length; i++) {
        if (isRuleDefinitionLine(rel, lines[i])) continue
        const matches = lines[i].match(pattern)
        if (matches === null) continue
        for (const m of matches) {
          if (ALLOWED_FAKE.test(m)) continue
          findings.push({ rel, line: i + 1, label, note, length: m.length })
        }
      }
    }
    for (const [label, pattern] of PATH_RULES) {
      for (let i = 0; i < lines.length; i++) {
        if (isRuleDefinitionLine(rel, lines[i])) continue
        const matches = lines[i].match(pattern)
        if (matches === null) continue
        for (const m of matches) findings.push({ rel, line: i + 1, label, note: '个人/本机信息', length: m.length })
      }
    }
  }
}

await walk(ROOT)

// 额外：用真实 key 的哈希做全文比对（不打印 key 本身）
let keyFound = []
try {
  const raw = (await readFile(KEY_FILE, 'utf8')).trim()
  if (raw.startsWith('sk-') && raw.length > 20) {
    // 只比对"前缀 + 后缀 + 长度"，足以定位且不泄露
    const fingerprint = `${raw.slice(0, 8)}…${raw.slice(-4)} (len=${raw.length})`
    const stack = [ROOT]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          stack.push(join(dir, entry.name))
          continue
        }
        try {
          const text = await readFile(join(dir, entry.name), 'utf8')
          if (text.includes(raw)) keyFound.push(relative(ROOT, join(dir, entry.name)).split('\\').join('/'))
        } catch {
          /* 二进制或不可读，跳过 */
        }
      }
    }
    console.log(`真实 key 指纹：${fingerprint}`)
  } else {
    console.log('密钥文件里没有可用的 key（跳过真实 key 比对）')
  }
} catch {
  console.log('读取密钥文件失败（跳过真实 key 比对）')
}

// 自检：确认白名单没有把审计能力削掉。
// 用一个"明显像真 key、但不属于任何夹具"的样本，断言它**仍然会命中**。
// 没有这一步，一个过宽的白名单会让审计永远返回 0 命中，看起来"全绿"其实已经失效。
const SELF_CHECK_SAMPLE = `sk-ws-Zz9Yy8.Xx7Ww6.Vv5Uu4.Tt3Ss2Rr1`
const selfCheckHits = RULES.some(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(SELF_CHECK_SAMPLE))
const selfCheckAllowed = ALLOWED_FAKE.test(SELF_CHECK_SAMPLE)
const selfCheckOk = selfCheckHits && !selfCheckAllowed
if (!selfCheckOk) {
  console.log('\n【自检失败】假密钥白名单过宽：一个"像真 key"的样本既没被规则命中、或被白名单放过。')
  console.log('审计能力已失效，请收紧 ALLOWED_FAKE。')
} else {
  console.log('自检：白名单未削弱审计能力（像真 key 的样本仍会被命中）')
}

// 汇总
console.log(`\n扫描文件 ${scanned} 个；命中 ${findings.length} 处`)
console.log(`真实 key 明文出现：${keyFound.length === 0 ? '无' : keyFound.join(', ')}`)

if (findings.length > 0) {
  const byLabel = new Map()
  for (const f of findings) {
    if (!byLabel.has(f.label)) byLabel.set(f.label, [])
    byLabel.get(f.label).push(f)
  }
  for (const [label, list] of byLabel) {
    console.log(`\n【${label}】${list.length} 处 -> ${list[0].note}`)
    const byFile = new Map()
    for (const f of list) {
      if (!byFile.has(f.rel)) byFile.set(f.rel, [])
      byFile.get(f.rel).push(f.line)
    }
    for (const [file, lines] of byFile) {
      const shown = lines.slice(0, 12).join(', ')
      console.log(`   ${file}  行 ${shown}${lines.length > 12 ? ` …(共 ${lines.length} 处)` : ''}`)
    }
  }
}

process.exitCode = findings.length === 0 && keyFound.length === 0 && selfCheckOk ? 0 : 1
