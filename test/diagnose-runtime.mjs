/**
 * 对"运行时副本"跑无损 JSON 诊断 —— 排除"我测的是源码、真机跑的是副本"这种错位。
 *
 * 复刻真机上那两次失败调用的完整参数（含 constraints / style / kind=component），
 * 并用 DSH 自己的规则校验返回结果。
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLossless } from './lossless.mjs'

import { pathToFileURL } from 'node:url'

const RUNTIME = process.env.DSH_DESIGN_RUNTIME ?? '<用户目录>/.dsh/profiles/desktop/node_modules/dsh-design-sketch'
const base = pathToFileURL(RUNTIME.endsWith('/') ? RUNTIME : `${RUNTIME}/`).href
const { encodePng } = await import(`${base}core.mjs`)
const { createTool } = await import(`${base}index.mjs`)

const KEY = 'sk-fake-key-runtime-diagnostic'
const sandbox = await mkdtemp(join(tmpdir(), 'runtime-lossless-'))
const outputDir = join(sandbox, 'demo', 'design')
await mkdir(outputDir, { recursive: true })

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
let seq = 0
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
    seq++
    return jsonResponse({ output: { task_id: `t${seq}`, task_status: 'PENDING' }, request_id: `r${seq}` })
  }
  if (target.includes('/api/v1/tasks/')) {
    const id = target.split('/').pop()
    return jsonResponse({
      output: { task_id: id, task_status: 'SUCCEEDED', choices: [{ message: { role: 'assistant', content: [{ image: `https://fake.local/oss/${id}.png` }] } }] },
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

// 与真机失败调用完全一致的参数
const args = {
  title: '曲目列表行',
  prompt: '音乐评分网站专辑页里的"曲目列表行"组件：一行显示曲目序号、播放按钮、曲名、艺术家、时长、播放量、收藏爱心。需要展示鼠标悬停整行高亮、当前正在播放的那一行有独立标记、以及长曲名截断的表现。每行左侧留出拖拽排序的抓手位置。',
  kind: 'component',
  aspect: '16:9',
  style: '深色主题，琥珀色（#F5A623）作为强调色，行高紧凑、信息密度高，圆角 12px，细分割线',
  constraints: ['组件画布用中性深灰底（不要纯黑），四周留边距', '每个状态旁标注中文状态名：默认、悬停、按下、聚焦、禁用、加载中', '颜色只允许黑/白/灰 + 琥珀色强调，不要引入第三种色相', '所有文字用中文，数字用无衬线体'],
}

console.log('运行时副本：', RUNTIME)
const result = await tool.execute(args)
console.log('ok =', result.ok, '| version =', result.version, '| size =', result.size, '| imageTier =', result.imageTier)
const verdict = validateLossless(result)
console.log(verdict.ok ? '无损 JSON 通过（DSH 会接受这个结果）' : `无损 JSON 失败 → ${verdict.path}：${verdict.reason}`)
console.log('返回的自有键：', Object.keys(result).join(','))
const withUndefined = Object.entries(result).filter(([, value]) => value === undefined).map(([key]) => key)
console.log('值为 undefined 的键：', withUndefined.length === 0 ? '（无）' : withUndefined.join(','))

await rm(sandbox, { recursive: true, force: true })
process.exitCode = verdict.ok && withUndefined.length === 0 ? 0 : 1
