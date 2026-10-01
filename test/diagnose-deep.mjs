/**
 * 找出真机上"无损 JSON"到底拒了哪个路径。
 *
 * 做法：对运行时副本跑真实 execute()（桩 fetch，零花费），然后：
 *   1. 用 DSH 的 cloneJson 规则（含 realm 语义）校验结果
 *   2. 模拟 JSON 往返，列出往返前后**消失或改变的字段**
 *   3. 检查同一对象是否被挂到多个位置（重复引用 → ancestors 判定会当成循环）
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateLossless } from './lossless.mjs'

const RUNTIME = process.env.DSH_DESIGN_RUNTIME ?? '<用户目录>/.dsh/profiles/desktop/node_modules/dsh-design-sketch'
const base = pathToFileURL(RUNTIME.endsWith('/') ? RUNTIME : `${RUNTIME}/`).href
const { encodePng } = await import(`${base}core.mjs`)
const { createTool } = await import(`${base}index.mjs`)

const KEY = 'sk-fake-key-diagnostic'
const sandbox = await mkdtemp(join(tmpdir(), 'lossless-deep-'))
const outputDir = join(sandbox, 'demo', 'design')
await mkdir(outputDir, { recursive: true })

const pixels = new Uint8Array(1520 * 848 * 4).fill(180)
const PNG = encodePng(1520, 848, pixels)
let seq = 0
const json = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), arrayBuffer: async () => new ArrayBuffer(0) })
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (options.method === 'POST') {
    seq++
    return json({ output: { task_id: `t${seq}`, task_status: 'PENDING' }, request_id: `r${seq}` })
  }
  if (target.includes('/api/v1/tasks/')) {
    const id = target.split('/').pop()
    return json({
      output: { task_id: id, task_status: 'SUCCEEDED', choices: [{ message: { role: 'assistant', content: [{ image: `https://f.local/oss/${id}.png` }] } }] },
      usage: { output_width: 1520, input_image_count: 0, input_image_type: 'qima_input_1k', output_image_count: 1, output_image_type: 'qima_output_1k', output_height: 848 },
      request_id: `rp-${id}`,
    })
  }
  if (target.includes('/oss/')) {
    const raw = Buffer.from(PNG)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }
  }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) }
}

const tool = createTool(
  { tools: { register: () => {}, get: () => undefined }, systemPrompt: { section: () => {}, getSectionOrder: () => 0 } },
  {
    apiKey: KEY, baseUrl: 'https://f.local', region: 'cn-beijing', model: 'qwen-image-3.0-pro',
    outputDir, workspaceRoot: sandbox, apiMode: 'async', quality: '1k', retries: 0,
    pollIntervalMs: 1, maxWaitMs: 5000, timeoutMs: 5000, banner: false,
  },
)

const result = await tool.execute({ title: '深度诊断', prompt: '一个页面', kind: 'screen', constraints: ['a', 'b'], style: 's' })

// ---- 1. 我方规则
const verdict = validateLossless(result)
console.log('1) 我方无损规则：', verdict.ok ? '通过' : `失败 → ${verdict.path}：${verdict.reason}`)

// ---- 2. 重复引用检测（cloneJson 的 ancestors 会把"同一对象挂两处"误判成循环）
const seen = new Map()
const dupes = []
const walkRefs = (node, path) => {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) {
    dupes.push(`${path} 与 ${seen.get(node)} 指向同一对象`)
    return
  }
  seen.set(node, path)
  if (Array.isArray(node)) return node.forEach((entry, index) => walkRefs(entry, `${path}[${index}]`))
  for (const [key, entry] of Object.entries(node)) walkRefs(entry, `${path}.${key}`)
}
walkRefs(result, 'root')
console.log('2) 重复引用：', dupes.length === 0 ? '（无）' : dupes.join('；'))

// ---- 3. JSON 往返差异
const roundTrip = JSON.parse(JSON.stringify(result))
const diff = []
for (const key of Object.keys(result)) {
  if (!(key in roundTrip)) diff.push(`顶层字段 ${key} 往返后消失`)
}
const deepDiff = (a, b, path) => {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return diff.push(`${path} 数组长度变化`)
    return a.forEach((entry, index) => deepDiff(entry, b[index], `${path}[${index}]`))
  }
  if (a === null || typeof a !== 'object') {
    if (!Object.is(a, b)) diff.push(`${path} 值变化：${JSON.stringify(a)} → ${JSON.stringify(b)}`)
    return
  }
  for (const [key, entry] of Object.entries(a)) {
    if (!(key in b)) diff.push(`${path}.${key} 往返后消失（值是 undefined？）`)
    else deepDiff(entry, b[key], `${path}.${key}`)
  }
}
deepDiff(result, roundTrip, 'root')
console.log('3) JSON 往返差异：', diff.length === 0 ? '（无）' : diff.join('；'))

// ---- 4. 非纯原型 / 非可枚举键 / symbol 键
const structureIssues = []
const checkStructure = (node, path) => {
  if (node === null || typeof node !== 'object') return
  const prototype = Object.getPrototypeOf(node)
  if (Array.isArray(node)) {
    if (prototype !== Array.prototype) structureIssues.push(`${path} 数组原型非本 realm 的 Array.prototype`)
    const keys = Reflect.ownKeys(node)
    if (keys.length !== node.length + 1) structureIssues.push(`${path} 自有键 ${keys.length} 个 ≠ length+1（${node.length + 1}）`)
  } else if (prototype !== Object.prototype && prototype !== null) {
    structureIssues.push(`${path} 原型是 ${prototype?.constructor?.name ?? 'null'}`)
  }
  const keys = Reflect.ownKeys(node)
  for (const key of keys) {
    if (typeof key === 'symbol') structureIssues.push(`${path} 带 symbol 键`)
    else if (key !== 'length' && !Object.prototype.propertyIsEnumerable.call(node, key)) structureIssues.push(`${path}.${key} 不可枚举`)
  }
  for (const [key, entry] of Object.entries(node)) checkStructure(entry, `${path}.${key}`)
}
checkStructure(result, 'root')
console.log('4) 结构问题：', structureIssues.length === 0 ? '（无）' : structureIssues.join('；'))

// ---- 5. 数字体检
const numberIssues = []
const checkNumbers = (node, path) => {
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) numberIssues.push(`${path} 非有限`)
    if (Object.is(node, -0)) numberIssues.push(`${path} 是 -0`)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach((entry, index) => checkNumbers(entry, `${path}[${index}]`))
  for (const [key, entry] of Object.entries(node)) checkNumbers(entry, `${path}.${key}`)
}
checkNumbers(result, 'root')
console.log('5) 数字问题：', numberIssues.length === 0 ? '（无）' : numberIssues.join('；'))

await writeFile(join(sandbox, 'result-dump.json'), JSON.stringify(roundTrip, null, 2), 'utf8')
console.log('\n结果顶层字段：', Object.keys(result).join(','))
console.log('content[0] 字段：', Object.keys(result.content?.[0] ?? {}).join(','))
console.log('content 文本长度：', result.content?.[0]?.text?.length ?? 0)

await rm(sandbox, { recursive: true, force: true })
const bad = !verdict.ok || dupes.length > 0 || diff.length > 0 || structureIssues.length > 0 || numberIssues.length > 0
console.log(bad ? '\n>>> 发现问题' : '\n>>> 本地一切正常（说明差异在真机环境，而非数据形状）')
process.exitCode = bad ? 1 : 0
