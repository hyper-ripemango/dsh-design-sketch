/**
 * 诊断：用桩 fetch 跑一次真实的 `execute()`，然后用 DSH 的无损 JSON 规则校验结果。
 *
 * 之所以要这么做：真机上工具报 `value is not lossless JSON`，但这个判断比"没有
 * undefined"严得多（还禁 -0、非法数组属性、非纯原型、symbol/不可枚举键、循环引用），
 * 而 JSON.stringify 会把这一切都掩盖掉。所以这里直接拿真规则跑，让它指出具体路径。
 *
 * 不产生网络请求与费用：全局 fetch 被替换成假实现，返回本地生成的 PNG。
 */

import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng } from '../core.mjs'
import { validateLossless } from './lossless.mjs'
import { createTool } from '../index.mjs'

const KEY = 'sk-fake-key-for-diagnostics-01'
const sandbox = await mkdtemp(join(tmpdir(), 'design-lossless-'))
const outputDir = join(sandbox, 'demo', 'design')
await mkdir(outputDir, { recursive: true })

/** 造一张真实 PNG（用真编码器，保证下载校验能过）。 */
function solidPng(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = 40
    pixels[index * 4 + 1] = 60
    pixels[index * 4 + 2] = 90
    pixels[index * 4 + 3] = 255
  }
  return encodePng(width, height, pixels)
}

const PNG = solidPng(1520, 848)
let taskSeq = 0
const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(payload),
  arrayBuffer: async () => new ArrayBuffer(0),
})

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (options.method === 'POST') {
    taskSeq++
    return jsonResponse({ output: { task_id: `task-${taskSeq}`, task_status: 'PENDING' }, request_id: `req-${taskSeq}` })
  }
  if (target.includes('/api/v1/tasks/')) {
    const id = target.split('/').pop()
    return jsonResponse({
      output: {
        task_id: id,
        task_status: 'SUCCEEDED',
        choices: [{ message: { role: 'assistant', content: [{ image: `https://fake.local/oss/${id}.png` }, { actual_prompt: '改写后的提示词' }] } }],
      },
      usage: { output_width: 1520, output_height: 848, output_image_count: 1 },
      request_id: `req-poll-${id}`,
    })
  }
  if (target.includes('/oss/')) {
    const raw = Buffer.from(PNG)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    }
  }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) }
}

const config = {
  apiKey: KEY,
  baseUrl: 'https://fake.local',
  region: 'cn-beijing',
  model: 'qwen-image-3.0-pro',
  outputDir,
  workspaceRoot: sandbox,
  apiMode: 'async',
  quality: '1k',
  retries: 0,
  pollIntervalMs: 1,
  maxWaitMs: 5000,
  timeoutMs: 5000,
  banner: false,
}

const ctx = { tools: { register: () => {}, get: () => undefined }, systemPrompt: { section: () => {}, getSectionOrder: () => 0 } }
const tool = createTool(ctx, config)

const cases = [
  ['T2I 成功（最小参数）', { title: '诊断页', prompt: '一个测试页面', kind: 'screen' }],
  ['component + constraints + style', {
    title: '曲目列表行',
    prompt: '音乐评分网站的曲目列表行组件',
    kind: 'component',
    aspect: '16:9',
    style: '深色主题，琥珀色强调',
    constraints: ['画布用中性深灰底', '每个状态旁标注中文状态名'],
  }],
  ['带 seed', { title: '带种子', prompt: 'x', seed: 42 }],
  ['缺失参数（失败路径）', { title: '  ', prompt: '' }],
  ['未配密钥（失败路径）', { title: '无密钥', prompt: 'x', __config: { ...config, apiKey: '' } }],
  ['reviseOf 不存在（失败路径）', { title: '不存在版本', prompt: 'x', reviseOf: 'v99' }],
]

let problems = 0
for (const [label, args] of cases) {
  const { __config, ...rest } = args
  const active = __config === undefined ? tool : createTool(ctx, __config)
  let result = null
  try {
    result = await active.execute(rest)
  } catch (error) {
    console.log(`[${label}] execute 抛异常：${error.message}`)
    problems++
    continue
  }
  const verdict = validateLossless(result)
  if (verdict.ok) {
    console.log(`[${label}] 无损 JSON 通过`)
  } else {
    problems++
    console.log(`[${label}] 无损 JSON 失败 → ${verdict.path}：${verdict.reason}`)
  }
  // 再检查一个容易忽略的点：结果里"自有键"是否含 undefined（JSON.stringify 会掩盖）
  const dangling = []
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
    if (node === null || typeof node !== 'object') return
    for (const [key, entry] of Object.entries(node)) {
      if (entry === undefined) dangling.push(`${path}.${key}`)
      else walk(entry, `${path}.${key}`)
    }
  }
  walk(result, 'root')
  if (dangling.length > 0) {
    problems++
    console.log(`    附带：含 undefined 的键 → ${dangling.join('、')}`)
  }
}

await rm(sandbox, { recursive: true, force: true })
console.log(`\n问题数 = ${problems}`)
process.exitCode = problems === 0 ? 0 : 1
