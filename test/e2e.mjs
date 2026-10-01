/**
 * dsh-design-sketch 端到端测试 —— 假 DashScope 服务 + 真实 execute 路径。
 *
 * 与 `smoke.mjs` 的区别：这里不复用内部函数，而是**真的调用工具的 `execute()`**，
 * 于是把整条链路都跑通并断言副作用：
 *   建异步任务 → 轮询 → 下载 PNG → 版本号分配 → 元数据落盘 → 目录索引重建 →
 *   迭代链（reviseOf 走 I2I）→ 失败时不撒谎 → 密钥零泄露。
 *
 * 网络只指向 127.0.0.1 的临时假服务，所以零花费、可重复。
 * 依赖 `test/node_modules/@deepseek-ai/*` 两个测试替身来顶掉 DSH 运行时。
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng, readImageSize, sniffImageMime } from '../core.mjs'
import { createTool } from '../index.mjs'

// ------------------------------------------------------------------ 断言

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    return true
  }
  failures.push(`${label}${detail.length > 0 ? ` — ${detail}` : ''}`)
  return false
}
const eq = (label, actual, expected) => check(label, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)

// ------------------------------------------------------------- 假服务

/** 造一张纯色 PNG（用真实编码器，保证图片头/尺寸可双向解析）。 */
function solidPng(width, height, rgb) {
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[0]
    pixels[i * 4 + 1] = rgb[1]
    pixels[i * 4 + 2] = rgb[2]
    pixels[i * 4 + 3] = 255
  }
  return encodePng(width, height, pixels)
}

// 用请求里指定的尺寸回图，这样"请求尺寸 → 落盘图尺寸 → 计费档"能被端到端验证，
// 而不是被一个固定尺寸的假图掩盖掉。
const imageCache = new Map()
const imageFor = (sizeText) => {
  const m = /^(\d+)\*(\d+)$/.exec(sizeText ?? '')
  const width = m === null ? 1520 : Number(m[1])
  const height = m === null ? 848 : Number(m[2])
  const key = `${width}x${height}`
  if (!imageCache.has(key)) imageCache.set(key, solidPng(width, height, [30, 60, 120]))
  return imageCache.get(key)
}
const IMAGE = solidPng(1520, 848, [30, 60, 120])
const requests = []
let taskSeq = 0
let pollSeq = 0
const createdBodies = []
const downloadedPaths = []
const taskSizes = new Map()

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw })

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    // 1) 建异步任务
    if (req.method === 'POST' && req.url.includes('/api/v1/services/aigc/image-generation/generation')) {
      if (String(req.headers.authorization ?? '') !== `Bearer ${GOOD_KEY}`) {
        return json(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.', request_id: 'req-401' })
      }
      if (raw.includes('"model":"qwen-image-3.0-pro-bad"')) {
        return json(400, { code: 'ModelNotExist', message: 'model not exist', request_id: 'req-model' })
      }
      createdBodies.push(JSON.parse(raw))
      taskSeq++
      const parsed = JSON.parse(raw)
      taskSizes.set(`task-${taskSeq}`, parsed?.parameters?.size ?? '')
      return json(200, { output: { task_id: `task-${taskSeq}`, task_status: 'PENDING' }, request_id: `req-create-${taskSeq}` })
    }

    // 2) 轮询任务
    if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
      const id = req.url.split('/').pop()
      pollSeq++
      if (pollSeq === 1) return json(200, { output: { task_id: id, task_status: 'RUNNING' }, request_id: 'req-poll' })
      return json(200, {
        output: {
          task_id: id,
          task_status: 'SUCCEEDED',
          choices: [{ message: { role: 'assistant', content: [{ image: `http://127.0.0.1:${port}/oss/${id}.png` }] } }],
        },
        usage: { output_width: 1520, output_height: 848, output_image_count: 1 },
        request_id: `req-poll-${id}`,
      })
    }

    // 3) 图片下载
    if (req.method === 'GET' && req.url.startsWith('/oss/')) {
      downloadedPaths.push(req.url)
      const taskId = req.url.slice('/oss/'.length).replace(/\.png$/, '')
      const bytes = imageFor(taskSizes.get(taskId))
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(bytes)
    }

    return json(404, { code: 'NotFound', message: `未预置的路由：${req.url}` })
  })
})

const GOOD_KEY = 'sk-fake-key-for-tests-only-0001'
const port = await new Promise((done) => {
  server.listen(0, '127.0.0.1', () => done(server.address().port))
})

// ------------------------------------------------------------------ 环境

const sandbox = await mkdtemp(join(tmpdir(), 'design-sketch-e2e-'))
const workspaceRoot = join(sandbox, 'workspace')
const outputDir = join(workspaceRoot, 'demo', 'design')
await stat(workspaceRoot).catch(async () => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(outputDir, { recursive: true })
})

const baseConfig = {
  apiKey: GOOD_KEY,
  baseUrl: `http://127.0.0.1:${port}`,
  region: 'cn-beijing',
  model: 'qwen-image-3.0-pro',
  outputDir,
  workspaceRoot,
  apiMode: 'async',
  quality: '1k',
  retries: 0,
  pollIntervalMs: 1,
  maxWaitMs: 5000,
  timeoutMs: 5000,
  banner: false,
}

/** 最小的 ctx 替身：本插件只在 apply() 里用 ctx，测试直接调 execute。 */
const ctx = {
  tools: { register: () => {}, get: () => undefined },
  systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
}

/** 按输出 schema 校验工具结果：DSH 会在每次调用后做这件事，这里先自己过一遍。 */
function validateToolResult(schema, value, path = 'root') {
  const problems = []
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  // 第一步先查"无损 JSON"。带 undefined 属性的对象**不是**无损 JSON，DSH 会整条拒收
  // （报 `value is not lossless JSON`），而 JSON.stringify 会静默丢掉这种属性 ——
  // 所以必须自己递归扫一遍。这一条是拿真机调用换来的教训：测试比真机宽松 = 没测。
  const scanLossless = (node, nodePath) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => {
        if (entry === undefined) problems.push(`${nodePath}[${index}] 是 undefined（数组不能有空洞）`)
        else scanLossless(entry, `${nodePath}[${index}]`)
      })
      return
    }
    if (node === null) return
    if (typeof node !== 'object') {
      if (typeof node === 'function' || typeof node === 'bigint' || typeof node === 'symbol') problems.push(`${nodePath} 是不可序列化的 ${typeof node}`)
      if (typeof node === 'number' && !Number.isFinite(node)) problems.push(`${nodePath} 是非有限数字 ${node}`)
      return
    }
    for (const [key, entry] of Object.entries(node)) {
      if (entry === undefined) {
        problems.push(`${nodePath}.${key} 显式赋成了 undefined（DSH 会因"不是无损 JSON"拒收整个结果）`)
        continue
      }
      scanLossless(entry, `${nodePath}.${key}`)
    }
  }
  scanLossless(value, path)

  const expected = schema.type
  const actual = typeOf(value)
  const typeOk =
    expected === 'json'
      ? true // DSH 的 json 类型接受任意可序列化值（内容块数组也算）
      : expected === 'integer'
        ? Number.isInteger(value)
        : expected === 'number'
          ? typeof value === 'number'
          : expected === actual
  if (!typeOk) return [`${path} 类型应为 ${expected}，实际 ${actual}`]
  if (expected === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}.${key} 缺失但 required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) problems.push(`${path}.${key} 不在 schema 里但 additionalProperties=false`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (!(key in value) || value[key] === undefined) continue
      problems.push(...validateToolResult(sub, value[key], `${path}.${key}`))
    }
  }
  if (expected === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => problems.push(...validateToolResult(schema.items, entry, `${path}[${index}]`)))
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${path} 取值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`)
  return problems
}

const tool = createTool(ctx, baseConfig)
eq('工具名', tool.name, 'design_sketch')
check('工具描述提到 reviseOf', tool.description.includes('reviseOf'))
check('工具参数含 title/prompt', tool.parameters.title !== undefined && tool.parameters.prompt !== undefined)
check('输出 schema 是对象', tool.output.schema.type === 'object')
check('render 返回 content', Array.isArray(tool.output.render({}, { content: [{ type: 'text', text: 'x' }] })))

// ----------------------------------------------------- 用例 1：T2I 首次生成

const first = await tool.execute({ title: '专辑详情页', prompt: '展示专辑封面、曲目列表与用户评分', kind: 'screen' })
eq('用例1 ok', first.ok, true)
eq('用例1 版本号', first.version, 'v01')
eq('用例1 模式', first.mode, 'T2I')
eq('用例1 画幅', first.aspect, '16:9')
eq('用例1 尺寸', first.size, '1520*848')
eq('用例1 实际档位', first.imageTier, '1k')
eq('用例1 估算费用', first.estimatedCostCny, 0.25)
eq('用例1 apiMode', first.apiMode, 'async')
eq('用例1 图片数', first.imagePaths.length, 1)
eq('用例1 目录名带日期', first.designDir.endsWith(join('demo', 'design', `专辑详情页_${dateStamp()}`)), true)

const pngInfo = await stat(first.imagePaths[0])
check('用例1 PNG 真的落盘了', pngInfo.size > 1000, `${pngInfo.size} 字节`)
const pngBytes = await readFile(first.imagePaths[0])
eq('用例1 落盘的是 PNG', sniffImageMime(pngBytes), 'image/png')
const written = readImageSize(pngBytes)
eq('用例1 落盘图宽', written.width, 1520)
eq('用例1 落盘图高', written.height, 848)

const meta = JSON.parse(await readFile(first.metaPath, 'utf8'))
eq('用例1 元数据 schema', meta.schema, 'dsh-design-sketch/version@1')
eq('用例1 元数据版本', meta.version, 'v01')
eq('用例1 元数据记录用户需求', meta.userPrompt, '展示专辑封面、曲目列表与用户评分')
eq('用例1 元数据记录模型', meta.model, 'qwen-image-3.0-pro')
eq('用例1 元数据记录计费档', meta.result.costCny, 0.25)
eq('用例1 元数据记录实际档位', meta.result.tier, '1k')
check('用例1 元数据不含密钥', !JSON.stringify(meta).includes(GOOD_KEY))
check('用例1 元数据里没有 Bearer', !JSON.stringify(meta).includes('Bearer'))

const index = await readFile(first.indexPaths[0], 'utf8')
check('用例1 索引列出 v01', index.includes('v01'))
check('用例1 索引含用户需求', index.includes('展示专辑封面'))
check('用例1 索引含完整提示词', index.includes('前端界面视觉稿'))

const content = first.content[0].text
check('用例1 正文含 Markdown 图片', /!\[.+?\]\(<.+?>\)/.test(content))
check('用例1 正文里的图片路径是工作区相对路径', content.includes('demo/design/'))
check('用例1 正文提示先给用户看图', content.includes('用户看到图之前不要开始写前端代码'))
check('用例1 正文报价', content.includes('¥0.25'))

// 请求体形状：这是本插件最核心的契约，逐条对官方文档
const sentBody = createdBodies[0]
eq('请求体 model', sentBody.model, 'qwen-image-3.0-pro')
eq('请求体 messages 只有一轮', sentBody.input.messages.length, 1)
eq('请求体 role 是 user', sentBody.input.messages[0].role, 'user')
eq('请求体 content 只有一个 text（T2I）', sentBody.input.messages[0].content.length, 1)
check('请求体 text 含模板骨架', sentBody.input.messages[0].content[0].text.includes('前端界面视觉稿'))
eq('请求体 size 用星号', sentBody.parameters.size, '1520*848')
eq('请求体 n 是整数', Number.isInteger(sentBody.parameters.n), true)
eq('请求体带 negative_prompt', typeof sentBody.parameters.negative_prompt, 'string')
eq('请求体默认开 prompt_extend', sentBody.parameters.prompt_extend, true)
eq('请求体默认不开水印', sentBody.parameters.watermark, false)
const createReq = requests.find((r) => r.method === 'POST')
eq('异步请求头 X-DashScope-Async', createReq.headers['x-dashscope-async'], 'enable')
eq('鉴权头格式', createReq.headers.authorization, `Bearer ${GOOD_KEY}`)
check('鉴权头是 ASCII（防止中文混入导致 400）', /^[\x20-\x7e]+$/.test(createReq.headers.authorization))
eq('轮询确实发生（先 RUNNING 后 SUCCEEDED）', pollSeq >= 2, true)

// ------------------------------------------------- 用例 2：带意见的局部改图

const second = await tool.execute({
  title: '专辑详情页',
  prompt: '保持整体布局与配色不变，只把曲目列表的行高加大、播放按钮换成更大的圆形图标',
  kind: 'screen',
  reviseOf: 'v01',
})
eq('用例2 ok', second.ok, true)
eq('用例2 版本号', second.version, 'v02')
eq('用例2 模式', second.mode, 'I2I')
eq('用例2 记录基于 v01', second.basedOn, 'v01')
eq('用例2 复用同一目录', second.designDir, first.designDir)

const i2iBody = createdBodies[1]
eq('I2I content = 图 + 文', i2iBody.input.messages[0].content.length, 2)
eq('I2I 第一项是图片', Object.keys(i2iBody.input.messages[0].content[0])[0], 'image')
check('I2I 图片是 base64 data URL', String(i2iBody.input.messages[0].content[0].image).startsWith('data:image/png;base64,'))
eq('I2I 第二项是文本', Object.keys(i2iBody.input.messages[0].content[1])[0], 'text')
check('I2I 文本含修改意见', i2iBody.input.messages[0].content[1].text.includes('行高加大'))

const meta2 = JSON.parse(await readFile(second.metaPath, 'utf8'))
eq('用例2 元数据记录 basedOn', meta2.request.basedOn, 'v01')
eq('用例2 元数据记录参考图来源', meta2.request.references[0].kind, 'basedOn')
check('用例2 元数据不含 base64 图片载荷', !JSON.stringify(meta2).includes('data:image/png;base64,'))
const index2 = await readFile(second.indexPaths[0], 'utf8')
check('用例2 索引同时列出 v01 与 v02', index2.includes('v01') && index2.includes('v02'))
check('用例2 索引标注 I2I', index2.includes('I2I'))
check('用例2 索引标注基于哪一版', index2.includes('基于：v01'))

// 目录里应有：v01.png/json、v02.png/json、README.md
const files = (await readdir(first.designDir)).sort()
check('目录文件齐全', ['README.md', 'v01.json', 'v01.png', 'v02.json', 'v02.png'].every((f) => files.includes(f)), files.join(', '))

// ------------------------------------------------------ 用例 3：组件 + 2K

const component = await tool.execute({ title: '主按钮', prompt: '深色主题的主操作按钮，带图标', kind: 'component', quality: '2k' })
eq('用例3 ok', component.ok, true)
eq('用例3 默认画幅（component → 1:1）', component.aspect, '1:1')
eq('用例3 2K 档位', component.imageTier, '2k')
eq('用例3 2K 费用', component.estimatedCostCny, 0.5)
const meta3 = JSON.parse(await readFile(component.metaPath, 'utf8'))
eq('用例3 元数据档位与工具返回一致', meta3.result.tier, component.imageTier)
eq('用例3 版本从 v01 起（新目录）', component.version, 'v01')
const componentBody = createdBodies[2]
check('component 模板要求画出状态', componentBody.input.messages[0].content[0].text.includes('禁用'))
check('component 尺寸被算成 1:1', /^(\d+)\*(\d+)$/.test(componentBody.parameters.size))
check('component 画幅接近正方', Math.abs(Number(componentBody.parameters.size.split('*')[0]) - Number(componentBody.parameters.size.split('*')[1])) <= 32)

// ------------------------------------------------------ 用例 4：故意失败

const badKeyTool = createTool(ctx, { ...baseConfig, apiKey: 'sk-wrong-key-000000000000' })
const badKey = await badKeyTool.execute({ title: '密钥错的情况', prompt: 'x' })
eq('用例4a ok=false', badKey.ok, false)
check('用例4a 提示 key 无效', badKey.content[0].text.includes('InvalidApiKey') || badKey.content[0].text.includes('API Key'))
check('用例4a 不把密钥写进错误信息', !badKey.content[0].text.includes('sk-wrong-key'))
check('用例4a 给出了可操作下一步（keyFile / 环境变量）', badKey.content[0].text.includes('keyFile') && badKey.content[0].text.includes('DASHSCOPE_API_KEY'))

const noKeyTool = createTool(ctx, { ...baseConfig, apiKey: '', keyFile: '' })
const noKey = await noKeyTool.execute({ title: '没有密钥', prompt: 'x' })
eq('用例4b 无密钥时 ok=false', noKey.ok, false)
check('用例4b 说明密钥来源', noKey.content[0].text.includes('没有可用的 DashScope API Key'))

const noDirTool = createTool(ctx, { ...baseConfig, outputDir: '' })
const noDir = await noDirTool.execute({ title: '没配目录', prompt: 'x' })
eq('用例4c 未配 outputDir 时 ok=false', noDir.ok, false)
check('用例4c 提示要配 outputDir', noDir.content[0].text.includes('outputDir'))

const emptyArgs = await tool.execute({ title: '  ', prompt: '' })
eq('用例4d 缺参数时 ok=false', emptyArgs.ok, false)
check('用例4d 指出缺 title', emptyArgs.content[0].text.includes('缺少 title'))
const emptyPrompt = await tool.execute({ title: '有名字但没描述', prompt: '   ' })
eq('用例4d2 缺 prompt 时 ok=false', emptyPrompt.ok, false)
check('用例4d2 指出缺 prompt', emptyPrompt.content[0].text.includes('缺少 prompt'))

const badSize = await tool.execute({ title: '尺寸越界', prompt: 'x', size: '9000*9000' })
eq('用例4e 尺寸越界时 ok=false', badSize.ok, false)
check('用例4e 说明单边范围', badSize.content[0].text.includes('512'))

const badRevise = await tool.execute({ title: '专辑详情页', prompt: 'x', reviseOf: 'v99' })
eq('用例4f 引用不存在的版本时 ok=false', badRevise.ok, false)
check('用例4f 列出该目录现有版本', badRevise.content[0].text.includes('v01') && badRevise.content[0].text.includes('v02'))

const badRef = await tool.execute({ title: '参考图不存在', prompt: 'x', reference: [join(sandbox, 'not-here.png')] })
eq('用例4g 参考图不存在时 ok=false', badRef.ok, false)
check('用例4g 提示参考图不可用', badRef.content[0].text.includes('参考图'))

const noI2iModel = await tool.execute({ title: '模型不支持改图', prompt: 'x', reference: ['https://example.com/ref.png'], model: 'qwen-image-plus' })
eq('用例4h 纯文生图模型 + 参考图时 ok=false', noI2iModel.ok, false)
check('用例4h 提示换模型', noI2iModel.content[0].text.includes('不支持图生图'))

// 失败也要留痕：目录里应有 .failed.json
const dirFiles = await readdir(join(outputDir, `密钥错的情况_${dateStamp()}`)).catch(() => [])
check('失败现场也留痕（.failed.json）', dirFiles.some((f) => f.endsWith('.failed.json')), dirFiles.join(', '))
const failedMeta = JSON.parse(await readFile(join(outputDir, `密钥错的情况_${dateStamp()}`, dirFiles.find((f) => f.endsWith('.failed.json'))), 'utf8'))
check('失败留痕含错误信息', String(failedMeta.error ?? '').length > 0)
check('失败留痕不含密钥', !JSON.stringify(failedMeta).includes('sk-wrong-key'))
check('失败留痕含原始提示词（便于复盘）', String(failedMeta.prompt ?? '').length > 0)

// ------------------------------------------------------ 用例 5：结果契约

// 每个返回值都必须能过自身的输出 schema —— DSH 在每次调用后都会做这道校验，
// 一个越界的 enum 或多余的字段就会让整个工具结果被拒。
const results = [
  ['T2I 成功', first],
  ['I2I 成功', second],
  ['component 成功', component],
  ['密钥错误', badKey],
  ['无密钥', noKey],
  ['未配目录', noDir],
  ['缺参数', emptyArgs],
  ['尺寸越界', badSize],
  ['reviseOf 不存在', badRevise],
  ['模型不支持 I2I', noI2iModel],
]
for (const [label, value] of results) {
  const problems = validateToolResult(tool.output.schema, value)
  check(`用例5 结果过 schema：${label}`, problems.length === 0, problems.join('；'))
  const rendered = tool.output.render({}, value)
  check(`用例5 render 可用：${label}`, Array.isArray(rendered) && rendered.length > 0 && typeof rendered[0].text === 'string')
}

// 自检：校验器必须能抓出"带 undefined 属性"这种结果 —— 否则它比真机宽松，等于没查。
// 这正是真机第一次调用时报 `value is not lossless JSON` 的那个缺陷。
const badShape = { ok: true, seed: undefined, content: [{ type: 'text', text: 'x' }] }
check(
  '自检：校验器能抓出 undefined 属性',
  validateToolResult({ type: 'object', additionalProperties: true, properties: {} }, badShape).some((p) => p.includes('undefined')),
  '校验器漏掉了 undefined 属性',
)
const badShapeProblems = validateToolResult(tool.output.schema, badShape)
check('自检：undefined 结果也会违反真实 schema', badShapeProblems.length > 0, '没检出来')

// 真机调用曾因此整条失败，所以单独断言一次：所有返回值的自有键都不能指向 undefined。
for (const [label, value] of results) {
  const dangling = []
  const walk = (node, nodePath) => {
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${nodePath}[${index}]`))
    if (node === null || typeof node !== 'object') return
    for (const [key, entry] of Object.entries(node)) {
      if (entry === undefined) dangling.push(`${nodePath}.${key}`)
      else walk(entry, `${nodePath}.${key}`)
    }
  }
  walk(value, 'root')
  check(`用例5 无 undefined 悬空字段：${label}`, dangling.length === 0, dangling.join('、'))
}

// -------------------------------------------------- 用例 6：全量泄露扫描

const everything = []
// 输出根目录下既有设计目录，也有 delivery-audit.log 这类文件（探针日志），两类都要扫。
const collect = async (full, name) => {
  if (/\.(json|md|log|txt)$/i.test(name)) everything.push({ full, text: await readFile(full, 'utf8') })
}
for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  const full = join(outputDir, entry.name)
  if (entry.isDirectory()) {
    for (const file of await readdir(full)) await collect(join(full, file), file)
  } else {
    await collect(full, entry.name)
  }
}
const leaked = everything.filter((entry) => entry.text.includes(GOOD_KEY) || entry.text.includes('Bearer '))
check('所有落盘文件都不含密钥', leaked.length === 0, leaked.map((e) => e.full).join(', '))
check('扫描覆盖面够大', everything.length >= 5, `只扫到 ${everything.length} 个文件`)
check('探针日志也被纳入泄露扫描', everything.some((entry) => entry.full.endsWith('delivery-audit.log')))

// ------------------------------------------------------------------ 收尾

function dateStamp(now = new Date()) {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

await new Promise((done) => server.close(done))
await rm(sandbox, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`  x ${item}`)
  process.exitCode = 1
} else {
  console.log('端到端全部通过')
}
