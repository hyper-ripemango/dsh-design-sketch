/**
 * dsh-design-sketch 冒烟测试 —— 零网络、零花费。
 *
 * 覆盖三层：
 *   1. 核心纯函数（日期、命名、提示词、尺寸、费用、请求体、响应解析、错误映射）
 *   2. 密钥处理（宽容提取 + 泄露面为 0）
 *   3. 任务链（建任务 → 轮询 → 限流重试 → 失败翻译 → 超时续查），用假 fetch 驱动
 *
 * 不 import 任何 DSH 包，所以可以直接 `node test/smoke.mjs` 跑。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASPECT_RATIOS,
  KIND_DEFAULT_ASPECT,
  PRICING,
  achievableTier,
  buildRequest,
  buildVersionMeta,
  composePrompt,
  computeSize,
  dateStamp,
  defaultNegativePrompt,
  designDirName,
  endpointFor,
  estimateCost,
  explainError,
  extractCredentials,
  normalizeReferences,
  parseSyncResult,
  parseTaskCreate,
  parseTaskResult,
  parseVersion,
  pollTask,
  postJson,
  readImageSize,
  redact,
  relativeForMarkdown,
  renderBannerPng,
  resolveBaseUrl,
  resolveCredentials,
  resolveOutputRoot,
  safeName,
  sniffImageMime,
  taskEndpoint,
  tierFor,
  toDataUrl,
  toPosix,
  versionSummaryLine,
  versionTag,
} from '../core.mjs'

// ------------------------------------------------------------------ 断言

let passed = 0
const failures = []

/** 简单断言；失败不中断，最后统一汇总。 */
function check(label, condition, detail = '') {
  if (condition) {
    passed++
    return true
  }
  failures.push(`${label}${detail.length > 0 ? ` — ${detail}` : ''}`)
  return false
}

const eq = (label, actual, expected) => check(label, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
const near = (label, actual, expected, tolerance = 1e-6) =>
  check(label, Math.abs(Number(actual) - expected) <= tolerance, `实际 ${actual}，期望 ${expected}`)

// ------------------------------------------------- 1. 核心纯函数

eq('dateStamp 固定日期', dateStamp(new Date(2026, 8, 30)), '20260930')
eq('versionTag 补零', versionTag(3), 'v03')
eq('versionTag 三位数', versionTag(100), 'v100')
eq('parseVersion 从 v03', parseVersion('v03'), 3)
eq('parseVersion 从纯数字串', parseVersion('2'), 2)
eq('parseVersion 从文件名', parseVersion('v12.json'), 12)
eq('parseVersion 无数字', parseVersion('最后一版'), null)

eq('safeName 去非法字符', safeName('专辑/详情:页*?'), '专辑_详情_页__')
eq('safeName 保留中文', safeName('专辑详情页'), '专辑详情页')
eq('safeName 空值兜底', safeName('   ', 'design'), 'design')
eq('safeName 抵抗 Windows 保留名', safeName('con'), '_con')
check('safeName 截断长度', safeName('长'.repeat(200)).length <= 60, `长度 ${safeName('长'.repeat(200)).length}`)
eq('toPosix 清 Windows 反斜杠', toPosix('C:\\dogx\\demo\\design'), 'C:/dogx/demo/design')

// 提示词
const screenPrompt = composePrompt({ kind: 'screen', prompt: '作品详情页', title: '专辑页', constraints: ['主色 #3B82F6'], style: '暗色' })
check('screen 模板含"前端界面视觉稿"', screenPrompt.includes('前端界面视觉稿'))
check('screen 模板含设计对象', screenPrompt.includes('【设计对象】专辑页'))
check('screen 模板含约束', screenPrompt.includes('- 主色 #3B82F6'))
check('screen 模板含风格', screenPrompt.includes('【视觉风格】暗色'))
const componentPrompt = composePrompt({ kind: 'component', prompt: '主按钮' })
check('component 模板要求全部交互状态', componentPrompt.includes('悬停') && componentPrompt.includes('禁用'))
check('未知 kind 回落到 free', composePrompt({ kind: '不存在的类型', prompt: 'x' }).includes('按下面的描述生成图像'))
check('constraints 支持字符串数组', composePrompt({ prompt: 'x', constraints: ['a', 'b'] }).includes('- a\n- b'))
check('negative 写进提示词', composePrompt({ prompt: 'x', negative: '不要圆角' }).includes('- 不要圆角'))
check('defaultNegativePrompt 对 UI 类含设备外框', defaultNegativePrompt('screen').includes('设备外框'))
check('defaultNegativePrompt 对素材类不含设备外框', !defaultNegativePrompt('asset').includes('设备外框'))

// 尺寸：面积不超预算、16 对齐、比例尽量准
const size169 = computeSize('16:9', '1k')
eq('16:9 1k 宽', size169.width, 1520)
eq('16:9 1k 高', size169.height, 848)
eq('16:9 1k 计费档', tierFor(size169.width, size169.height), '1k')
check('1k 档面积不超预算（否则费用会翻倍）', size169.area <= 1310720, `${size169.area}`)
const size1to1 = computeSize('1:1', '2k')
eq('1:1 2k 边长', size1to1.width, 1520)
eq('1:1 2k 实算档位', tierFor(size1to1.width, size1to1.height), '2k')
check('2k 档确实跨过 2K 计费线', size1to1.area > 2250000, `${size1to1.area}`)
const size219 = computeSize('21:9', '1k')
check('21:9 比例正确且不越界', Math.abs(size219.width / size219.height - 21 / 9) < 0.03 && size219.width <= 2048, `${size219.width}x${size219.height}`)
check('auto 返回 null 交给模型', computeSize('auto') === null)
check('超宽比报错', computeSize('99:1').error !== undefined)
check('所有内置画幅都合法', Object.keys(ASPECT_RATIOS).every((key) => {
  const s = computeSize(key, '1k')
  return s !== null && s.error === undefined && s.width >= 512 && s.height >= 512 && s.width <= 2048 && s.height <= 2048 && s.width % 16 === 0 && s.height % 16 === 0 && s.area <= 1310720
}))
check('极端长条在 2k 档下如实退回 1k（单边 2048 的物理限制）', achievableTier('21:9', '2k') === '1k')
check('常规画幅在 2k 档下确实是 2k', achievableTier('16:9', '2k') === '2k')
check('kind 默认画幅都有定义', ['screen', 'component', 'icon', 'flow', 'asset', 'free'].every((k) => KIND_DEFAULT_ASPECT[k] !== undefined))

// 费用（与官方价目一致）
near('1K 出图单价（北京）', estimateCost('cn-beijing', 1536, 864), 0.25)
near('2K 出图单价（北京）', estimateCost('cn-beijing', 2048, 1536), 0.5)
near('带 1 张输入图的费用', estimateCost('cn-beijing', 1536, 864, { inputImages: 1 }), 0.27)
near('n=3 的费用', estimateCost('cn-beijing', 1536, 864, { n: 3 }), 0.75)
near('新加坡 1K 单价', PRICING.singapore.out1k, 0.299768)

// 请求体
const t2i = buildRequest({ mode: 'native', model: 'qwen-image-3.0-pro', prompt: '画个按钮', params: { size: '1536*864', n: 1 } })
eq('T2I content 只有一个 text', t2i.input.messages[0].content.length, 1)
eq('T2I size 保持星号', t2i.parameters.size, '1536*864')
eq('T2I n 为整数', t2i.parameters.n, 1)
eq('T2I 默认 prompt_extend 开', t2i.parameters.prompt_extend, true)
eq('T2I 默认 watermark 关', t2i.parameters.watermark, false)
const i2i = buildRequest({
  mode: 'native',
  prompt: '只改按钮颜色',
  imageItems: [{ kind: 'path', value: 'data:image/png;base64,AAA' }],
  params: { size: '1024*1024', seed: 42, negative: '水印' },
})
eq('I2I content 长度 = 图 + 文', i2i.input.messages[0].content.length, 2)
eq('I2I 图片在前', Object.keys(i2i.input.messages[0].content[0])[0], 'image')
eq('I2I 文本在后', Object.keys(i2i.input.messages[0].content[1])[0], 'text')
eq('I2I seed 透传', i2i.parameters.seed, 42)
eq('I2I negative_prompt 透传', i2i.parameters.negative_prompt, '水印')
const oai = buildRequest({ mode: 'openai', prompt: 'x', imageItems: [{ kind: 'url', value: 'https://a/b.png' }], params: { size: '1536*864', n: 2 } })
eq('OpenAI 形状 size 用 x 分隔', oai.size, '1536x864')
eq('OpenAI 形状参数平铺', oai.prompt, 'x')
eq('OpenAI 形状单图传字符串', oai.image, 'https://a/b.png')
eq('OpenAI 形状不嵌套 input', oai.input, undefined)
const multi = buildRequest({ mode: 'openai', prompt: 'x', imageItems: [{ kind: 'url', value: 'a' }, { kind: 'url', value: 'b' }], params: {} })
check('OpenAI 形状多图传数组', Array.isArray(multi.image) && multi.image.length === 2)
eq('size 传 x 会被原生形状改成星号', buildRequest({ prompt: 'x', params: { size: '1024x1024' } }).parameters.size, '1024*1024')
eq('n 超上限被夹到 6', buildRequest({ prompt: 'x', params: { n: 99 } }).parameters.n, 6)
eq('n 为 0 时回落到 1', buildRequest({ prompt: 'x', params: { n: 0 } }).parameters.n, 1)

// 端点
eq('异步端点', endpointFor('https://dashscope.aliyuncs.com', 'async'), 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation')
eq('同步端点', endpointFor('https://dashscope.aliyuncs.com', 'sync'), 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
eq('OpenAI 兼容端点', endpointFor('https://dashscope.aliyuncs.com', 'openai'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations')
eq('域名末尾斜杠被清理', endpointFor('https://x.com///', 'async'), 'https://x.com/api/v1/services/aigc/image-generation/generation')
eq('任务查询端点做 URL 编码', taskEndpoint('https://x.com', 'abc 1'), 'https://x.com/api/v1/tasks/abc%201')

// 域名解析（key 与地域必须同域）
eq('无 workspaceId 用老域名', resolveBaseUrl({ region: 'cn-beijing' }), 'https://dashscope.aliyuncs.com')
eq('有 workspaceId 用专属域名', resolveBaseUrl({ region: 'cn-beijing', workspaceId: 'ws123456' }), 'https://ws123456.cn-beijing.maas.aliyuncs.com')
eq('新加坡老域名', resolveBaseUrl({ region: 'singapore' }), 'https://dashscope-intl.aliyuncs.com')
eq('显式 baseUrl 优先', resolveBaseUrl({ baseUrl: 'https://custom.example.com/', region: 'cn-beijing' }), 'https://custom.example.com')
eq('未知地域回落到北京', resolveBaseUrl({ region: 'mars' }), 'https://dashscope.aliyuncs.com')

// 响应解析
const created = parseTaskCreate({ output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'req-1' })
eq('解析 task_id', created.taskId, 'task-1')
eq('解析 request_id', created.requestId, 'req-1')
check('缺 task_id 时 ok=false', parseTaskCreate({ output: {} }).ok === false)
const taskResult = parseTaskResult({
  output: { task_status: 'SUCCEEDED', choices: [{ message: { role: 'assistant', content: [{ image: 'https://oss/x.png' }] } }] },
  usage: { output_width: 1536, output_height: 864, output_image_count: 1 },
  request_id: 'req-2',
})
eq('解析任务状态', taskResult.status, 'SUCCEEDED')
eq('解析图片 URL', taskResult.images[0], 'https://oss/x.png')
eq('解析用量', taskResult.usage.output_width, 1536)
const syncParsed = parseSyncResult({ data: [{ url: 'https://oss/y.png' }], usage: { output_image_count: 2 } })
eq('OpenAI 形状解析图片', syncParsed.images[0], 'https://oss/y.png')
eq('OpenAI 形状解析错误码', parseSyncResult({ error: { code: 'InvalidParameter', message: 'bad size' } }).code, 'InvalidParameter')
check('错误映射给出地域提示', explainError('InvalidApiKey', '').includes('地域'))
check('错误映射处理限流', explainError('Throttling', '').includes('RPM'))
check('未知错误码透传原文', explainError('Weird.Code', 'some detail').includes('some detail'))

// 密钥：宽容提取
// ⚠️ 本文件里出现的所有 `sk-...` 都是**虚构的测试夹具**，不是任何真实凭据。
// 它们只被传给纯函数做字符串解析断言，不会发起任何网络请求。
eq('提取标准 key', extractCredentials('sk-abcdefghijklmnop').apiKey, 'sk-abcdefghijklmnop')
// 回归：DashScope 的 workspace 级 key 形如 `sk-ws-<段>.<段>.<段>.<段>`，**含点号**。
// 早期字符类漏了点号，导致真 key 提取失败（文件明明写对了，工具却报"没找到 key"）。
// 下面的 `AbCdEf.GhIjKl.MnOpQr` 是刻意模仿该格式的**占位字母序列**，并非真实密钥。
const dottedKey = 'sk-ws-AbCdEf.GhIjKl.MnOpQr.StUvWx123456'
eq('提取含点号的 workspace 级 key', extractCredentials(dottedKey).apiKey, dottedKey)
eq('含点号 key 不做截断', extractCredentials(`${dottedKey}\n`).apiKey.length, dottedKey.length)
check('含点号 key 会被 redact 抹掉', !redact(`Bearer ${dottedKey}`).includes(dottedKey))
eq('提取带 BOM 的 key', extractCredentials('\uFEFFsk-abcdefghijklmnop').apiKey, 'sk-abcdefghijklmnop')
eq('提取带引号的 key', extractCredentials('"sk-abcdefghijklmnop"').apiKey, 'sk-abcdefghijklmnop')
eq('提取带标签的 key', extractCredentials('API Key: sk-abcdefghijklmnop\n').apiKey, 'sk-abcdefghijklmnop')
eq('提取带中文说明的 key', extractCredentials('这是我的key：sk-abcdefghijklmnop 请勿外传').apiKey, 'sk-abcdefghijklmnop')
eq('顺带提取业务空间 ID', extractCredentials('workspace id: ws123456\nsk-abcdefghijklmnop').workspaceId, 'ws123456')
eq('纯测试文字里没有 key', extractCredentials('你好，世界！\n这是一个测试文件。').apiKey, '')
eq('裸 token 也能认', extractCredentials('abcdefghijklmnopqrstuvwxyz123456').apiKey, 'abcdefghijklmnopqrstuvwxyz123456')
eq('纯数字不算 key', extractCredentials('12345678901234567890').apiKey, '')

// 密钥：泄露面必须为 0
const secret = 'sk-supersecretvalue123456'
check('redact 抹掉 sk- 明文', !redact(`Bearer ${secret}`).includes(secret))
check('redact 抹掉 data URL 载荷', !redact(`data:image/png;base64,${'A'.repeat(80)}`).includes('AAAA'))
const fromEnv = await resolveCredentials({ config: {}, env: { DASHSCOPE_API_KEY: secret } })
eq('环境变量来源标记', fromEnv.source, 'env')
eq('环境变量取到 key', fromEnv.apiKey, secret)
const fromCall = await resolveCredentials({ callKey: secret, config: { apiKey: 'sk-other' }, env: {} })
eq('调用参数优先于配置', fromCall.source, 'call')
const fromFileConfig = await resolveCredentials({ config: { apiKey: secret }, env: {} })
eq('配置里的 key 可用', fromFileConfig.source, 'config')
const missing = await resolveCredentials({ config: { keyFile: join(tmpdir(), 'definitely-missing-key-file.txt') }, env: {} })
eq('密钥文件不存在时拿不到 key', missing.apiKey, '')
check('密钥文件缺失有解释', String(missing.error ?? '').length > 0)
check('缺失信息里不含任何密钥明文', !String(missing.error ?? '').includes('sk-'))

// 图片嗅探与尺寸（手工拼一个仅头部合法的 PNG）
const pngHeader = (() => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1536, 0)
  ihdr.writeUInt32BE(864, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const body = Buffer.alloc(13)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
    body,
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND'),
    Buffer.alloc(4),
  ])
})()
eq('嗅探 PNG', sniffImageMime(pngHeader), 'image/png')
eq('嗅探 JPEG', sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg')
eq('嗅探 GIF', sniffImageMime(Buffer.from('GIF89a........', 'ascii')), 'image/gif')
eq('非图片返回空', sniffImageMime(Buffer.from('hello world, not an image')), '')
const readSize = readImageSize(pngHeader)
eq('读 PNG 宽', readSize.width, 1536)
eq('读 PNG 高', readSize.height, 864)
check('data URL 前缀正确', toDataUrl(Buffer.from([1, 2, 3]), 'image/png').startsWith('data:image/png;base64,'))

// 参考图归一化
eq('字符串路径 → path', normalizeReferences('C:\\a.png')[0].kind, 'path')
eq('URL → url', normalizeReferences('https://a/b.png')[0].kind, 'url')
eq('dataUrl → dataUrl', normalizeReferences('data:image/png;base64,AAA')[0].kind, 'dataUrl')
eq('对象数组', normalizeReferences([{ path: 'a.png' }, { url: 'https://b' }]).length, 2)
eq('空值安全', normalizeReferences(undefined).length, 0)

// 路径与索引
eq('相对路径用正斜杠', relativeForMarkdown('C:\\dogx\\demo\\design\\a\\v01.png', 'C:\\dogx'), 'demo/design/a/v01.png')
eq('目录外回落绝对路径', relativeForMarkdown('D:\\other\\v01.png', 'C:\\dogx'), 'D:/other/v01.png')
eq('未配置 workspaceRoot 时返回绝对路径', relativeForMarkdown('C:\\dogx\\a.png', ''), 'C:/dogx/a.png')
check('未配置 outputDir 时明确报错', resolveOutputRoot({}).ok === false)
check('配置 outputDir 后可用', resolveOutputRoot({ outputDir: 'C:\\dogx\\demo\\design' }).root.endsWith('design'))
eq('目录名含日期', designDirName('专辑页', new Date(2026, 8, 30)), '专辑页_20260930')

// 元数据
const meta = buildVersionMeta({
  version: 2, kind: 'screen', title: 'T', prompt: 'p', userPrompt: 'u', model: 'm', region: 'cn-beijing',
  aspect: '16:9', size: '1536*864', n: 1, seed: 7, negative: 'n',
  references: [{ kind: 'basedOn', name: 'v01.png', described: 'v01' }],
  basedOn: 'v01', width: 1536, height: 864, bytes: 100, elapsedSec: 40, costCny: 0.25, outputs: 1, files: { images: ['v02.png'] },
})
eq('元数据 schema', meta.schema, 'dsh-design-sketch/version@1')
eq('元数据版本标签', meta.version, 'v02')
eq('元数据记录基于哪一版', meta.request.basedOn, 'v01')
check('元数据不含密钥字段', !JSON.stringify(meta).toLowerCase().includes('apikey'))
check('摘要行标注 I2I', versionSummaryLine(meta).includes('I2I'))
check('摘要行标注 T2I', versionSummaryLine({ version: 'v01', request: { aspect: '1:1', references: [] }, result: { width: 1024, height: 1024, costCny: 0.25, elapsedSec: 30 } }).includes('T2I'))

// 自造 PNG 说明图
const banner = renderBannerPng({ width: 640, lines: ['qwen-image-3.0-pro  1536*864  16:9', 'v01  jing-xuan'] })
check('自造 PNG 是合法 PNG 头', banner.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
check('自造 PNG 以 IEND 结尾', banner.slice(-8, -4).toString('ascii') === 'IEND')
const bannerSize = readImageSize(banner)
eq('自造 PNG 宽度', bannerSize.width, 640)
check('自造 PNG 高度为正', bannerSize.height > 20, `高度 ${bannerSize.height}`)
eq('自造 PNG 类型', sniffImageMime(banner), 'image/png')

// ------------------------------------------------- 2. 任务链（假 fetch）

/** 假 fetch：按前缀路由，并把每次请求记进 log 供断言。 */
function fakeFetch(routes, log) {
  const counts = new Map()
  return async (url, options = {}) => {
    const route = routes.find((entry) => url.startsWith(entry.match))
    if (route === undefined) throw new Error(`测试未预置该请求：${url}`)
    const count = (counts.get(route.match) ?? 0) + 1
    counts.set(route.match, count)
    if (log !== undefined) log.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body })
    const response = route.respond(url, options, count) ?? {}
    const raw = response.raw === undefined ? Buffer.alloc(0) : Buffer.from(response.raw)
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: { get: () => null },
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {})),
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    }
  }
}

let pollCount = 0
const routes = [
  {
    match: 'https://fake.test/api/v1/services/aigc/image-generation/generation',
    respond: () => ({ status: 200, body: { output: { task_id: 'task-9', task_status: 'PENDING' }, request_id: 'req-create' } }),
  },
  {
    match: 'https://fake.test/api/v1/tasks/task-9',
    respond: () => {
      pollCount++
      if (pollCount === 1) return { status: 200, body: { output: { task_id: 'task-9', task_status: 'RUNNING' }, request_id: 'req-poll' } }
      return {
        status: 200,
        body: {
          output: {
            task_id: 'task-9',
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://fake.test/oss/v01.png' }, { actual_prompt: '增强后的提示词' }] } }],
          },
          usage: { output_width: 1536, output_height: 864, output_image_count: 1 },
          request_id: 'req-poll',
        },
      }
    },
  },
  { match: 'https://fake.test/oss/v01.png', respond: () => ({ status: 200, raw: banner }) },
]
const log = []
let sleeping = 0
const polled = await pollTask('task-9', {
  baseUrl: 'https://fake.test',
  headers: { Authorization: `Bearer ${secret}` },
  fetchImpl: fakeFetch(routes, log),
  intervalMs: 1,
  timeoutMs: 5000,
  sleepImpl: async () => {
    sleeping++
  },
})
check('轮询成功', polled.ok === true, JSON.stringify(polled).slice(0, 160))
eq('轮询了两次', polled.polls, 2)
eq('拿到图片 URL', polled.images[0], 'https://fake.test/oss/v01.png')
eq('拿到改写后的真实提示词', polled.actualPrompt, '增强后的提示词')
eq('中间确实等过一次', sleeping, 1)
const authHeader = log.find((item) => item.url.includes('/tasks/'))?.headers?.Authorization
check('任务查询带上了 Bearer', String(authHeader).startsWith('Bearer '))
check('请求体里不出现密钥', !JSON.stringify(log.map((item) => item.body ?? '')).includes(secret))

// 超时不算失败：要能把 task_id 交回去续查
const timeoutRoutes = [{ match: 'https://fake.test/api/v1/tasks/slow', respond: () => ({ status: 200, body: { output: { task_id: 'slow', task_status: 'RUNNING' } } }) }]
const hung = await pollTask('slow', { baseUrl: 'https://fake.test', fetchImpl: fakeFetch(timeoutRoutes), intervalMs: 1, timeoutMs: 1, sleepImpl: async () => {} })
eq('超时返回 pending 而不是失败', hung.pending, true)
eq('超时带上 taskId 供续查', hung.taskId, 'slow')
check('超时提示里说明 24 小时有效期', String(hung.error).includes('24 小时'))

// 任务失败：业务错误码要翻成人话
const failRoutes = [{ match: 'https://fake.test/api/v1/tasks/bad', respond: () => ({ status: 200, body: { output: { task_id: 'bad', task_status: 'FAILED', code: 'DataInspectionFailed', message: 'blocked' } } }) }]
const failedTask = await pollTask('bad', { baseUrl: 'https://fake.test', fetchImpl: fakeFetch(failRoutes), intervalMs: 1, timeoutMs: 100, sleepImpl: async () => {} })
eq('失败任务 ok=false', failedTask.ok, false)
check('失败原因被翻译', failedTask.error.includes('内容审核'))

// 限流：第一次 429，第二次成功（RPM 5 撞限流是常态）
const rateRoutes = [{ match: 'https://fake.test/rate', respond: (url, options, count) => (count <= 1 ? { status: 429, body: { code: 'Throttling', message: 'slow down' } } : { status: 200, body: { ok: true } }) }]
const retried = await postJson('https://fake.test/rate', { headers: {}, body: { x: 1 }, retries: 2, timeoutMs: 1000, fetchImpl: fakeFetch(rateRoutes), sleepImpl: async () => {} })
eq('限流后自动重试成功', retried.json.ok, true)

// 4xx 业务错误不重试，直接抛出可操作错误
const badRoutes = [{ match: 'https://fake.test/bad-request', respond: () => ({ status: 400, body: { code: 'InvalidParameter', message: 'n must be 1' } }) }]
let thrown = null
try {
  await postJson('https://fake.test/bad-request', { headers: {}, body: {}, retries: 3, fetchImpl: fakeFetch(badRoutes), sleepImpl: async () => {} })
} catch (error) {
  thrown = error
}
check('400 直接抛错', thrown !== null)
check('400 错误提示里点出 size 格式', String(thrown?.message ?? '').includes('size'))

// ------------------------------------------------- 3. 泄露面总检查

const leaked = JSON.stringify([meta, polled, { error: explainError('InvalidApiKey', `Bearer ${secret}`) }, { r: redact(`Authorization: Bearer ${secret}`) }])
check('汇总结果里不出现密钥明文', !leaked.includes(secret), '有泄漏')

// ------------------------------------------------------------------ 汇总

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`  x ${item}`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
