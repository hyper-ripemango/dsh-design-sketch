/**
 * dsh-design-sketch/core — 纯逻辑层：配置解析、密钥解析、提示词模板、尺寸与请求体、
 * 响应解析、HTTP 轮询、落盘、PNG 说明图生成。
 *
 * 这一层**不 import 任何 DSH 包**，因此可以在 DSH 之外直接跑单元测试
 * （见 `test/`），也可以在测试里把 `fetchImpl` 换成假实现，做到零网络、零花费
 * 地覆盖整条调用链。
 *
 * 隐私铁律：API Key 只出现在 HTTP 请求头里。它绝不进入
 * 落盘文件、工具结果、错误信息或日志——所有外向字符串都过 `redact()`。
 *
 * @module dsh-design-sketch/core
 */

import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// --------------------------------------------------------------------- 常量

/** 旧版通用域名（仍可用），按地域区分。 */
export const LEGACY_HOSTS = {
  'cn-beijing': 'https://dashscope.aliyuncs.com',
  singapore: 'https://dashscope-intl.aliyuncs.com',
}

/** 各地域的新版专属域名模板；`{workspaceId}` 由配置或密钥文件提供。 */
export const MAAS_HOSTS = {
  'cn-beijing': 'https://{workspaceId}.cn-beijing.maas.aliyuncs.com',
  singapore: 'https://{workspaceId}.ap-southeast-1.maas.aliyuncs.com',
  'us-east-1': 'https://{workspaceId}.us-east-1.maas.aliyuncs.com',
  'cn-hongkong': 'https://{workspaceId}.cn-hongkong.maas.aliyuncs.com',
  'eu-central-1': 'https://{workspaceId}.eu-central-1.maas.aliyuncs.com',
  'ap-northeast-1': 'https://{workspaceId}.ap-northeast-1.maas.aliyuncs.com',
}

/** 支持的图像生成与编辑模型；`edit` 表示是否支持图生图（I2I）。 */
export const MODELS = {
  'qwen-image-3.0-pro': { edit: true, family: '3.0', note: 'Pro：版面/小字/质感最强' },
  'qwen-image-3.0': { edit: true, family: '3.0', note: '标准：质量与速度兼顾' },
  'qwen-image-2.0-pro': { edit: true, family: '2.0', note: '上一代 Pro（同步接口）' },
  'qwen-image-2.0': { edit: true, family: '2.0', note: '上一代加速版（同步接口）' },
  'qwen-image-max': { edit: false, family: 'max', note: '纯文生图' },
  'qwen-image-plus': { edit: false, family: 'plus', note: '纯文生图' },
  'qwen-image': { edit: false, family: 'plus', note: '纯文生图' },
}

/** 3.0 系列在原生异步接口上的创建端点。 */
export const ASYNC_CREATE_PATH = '/api/v1/services/aigc/image-generation/generation'
/** 任务查询端点模板（必须同地域、同业务空间、同 key）。 */
export const TASK_PATH = '/api/v1/tasks/{taskId}'

/** 计费口径（元/张），与官方文档一致：按输出像素面积分 1K / 2K 两档。 */
export const PRICING = {
  'cn-beijing': { input: 0.02, out1k: 0.25, out2k: 0.5 },
  singapore: { input: 0.022483, out1k: 0.299768, out2k: 0.562065 },
  'us-east-1': { input: 0.02, out1k: 0.25, out2k: 0.5 },
  'eu-central-1': { input: 0.02, out1k: 0.25, out2k: 0.5 },
  'cn-hongkong': { input: 0.02, out1k: 0.25, out2k: 0.5 },
  'ap-northeast-1': { input: 0.00275, out1k: 0.03438, out2k: 0.068761 },
}

/** 输出像素面积的 1K / 2K 分档阈值：> 2_250_000 记 2K。 */
export const TIER_THRESHOLD_PX = 2250000
export const MIN_AREA_PX = 512 * 512
export const MAX_SIDE_PX = 2048
export const MIN_SIDE_PX = 512

/**
 * 默认画幅像素预算（按档位）。
 *
 * `1k` 压在 2_250_000 计费阈值**之下**（1_310_720），保证请求 1k 永远不会被判成 2K 档、
 * 费用不翻倍；`2k` 抬到阈值**之上**（2_350_000），留出 16 对齐的舍入余量，
 * 保证请求 2k 时确实拿到 2K 档画质（否则会出现"以为是 2K、其实按 1K 出图"的落差）。
 * 极端长条（3:1、21:9 之类）受单边 2048 限制，面积天然跨不过阈值，属例外。
 */
const AREA_BUDGET = { '1k': 1_310_720, '2k': 2_350_000, auto: 1_310_720 }

/** 常见画幅比 → 数值比；`auto` 交给模型自选。 */
export const ASPECT_RATIOS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '1:1': 1,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '21:9': 21 / 9,
  '2:1': 2,
  '1:2': 1 / 2,
  '3:1': 3,
  '1:3': 1 / 3,
}

/** `kind` → 默认画幅，按该类型最常见的形态给默认值。 */
export const KIND_DEFAULT_ASPECT = {
  screen: '16:9',
  component: '1:1',
  icon: '1:1',
  flow: '21:9',
  asset: '1:1',
  free: '16:9',
}

/** 支持的图片输入格式（官方列表），按魔数嗅探。 */
const MIME_BY_MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
]

/** 单张输入图上限 10MB（官方限制）。 */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024

// ------------------------------------------------------------------ 小程序

/** 数值夹取。 */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** 四舍五入到 step 的整数倍。 */
const roundTo = (value, step) => Math.max(step, Math.round(value / step) * step)

/** 正整数，带兜底与上限。 */
export const positiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.min(max, Math.floor(n))
}

/**
 * 从任意文本里抹掉可能的凭据。任何外向输出（错误信息、工具结果）都必须过这一层。
 * 覆盖 `Bearer xxx`、裸 `sk-xxx`、以及 data URL 里的 base64 长串。
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]{4,}/gi, 'Bearer <redacted>')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-<redacted>')
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}/gi, 'data:image/...;base64,<redacted>')
}

/**
 * 清洗 Windows 非法文件名字符。
 *
 * 与 bili-notes 同款做法，但**刻意保留中文**：设计稿目录名是给人看的展示名，
 * 不是标识符（`docs/00-map/CONVENTIONS.md` §1 分得很清楚：标识符用英文，
 * 汇报/文档用中文），所以保留汉字更合适。
 */
export function safeName(title, fallback = 'design', maxLength = 60) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
  const base = cleaned.length > 0 ? cleaned : String(fallback)
  const trimmed = base.slice(0, maxLength).replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed) ? `_${trimmed}` : trimmed
}

/** 本地日期标签，形如 `20260930`。 */
export function dateStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 本地时间戳，形如 `2026-09-30T21:05:03+08:00`。 */
export function isoLocal(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Windows 路径 → 正斜杠，便于写进 Markdown。 */
export const toPosix = (p) => String(p ?? '').split(sep).join('/')

/** `v03` / `3` / `v3.json` → 3；无法解析时返回 null。 */
export function parseVersion(value) {
  const m = String(value ?? '').match(/(\d{1,3})/)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

// -------------------------------------------------------------------- 密钥

/**
 * API Key 允许出现的字符。
 *
 * **必须包含 `.`**：DashScope 的 workspace 级 key 形如 `sk-ws-<段>.<段>.<段>.<段>`，
 * 点号是分隔符。早期版本漏了点号，导致贪婪匹配在第一个点就停下、整个提取失败 ——
 * 也就是"密钥文件明明写对了，工具却报没找到 key"。这种 bug 只有拿真 key 试才会暴露。
 * 连字符放在字符类末尾，避免被判成区间（`_-` 是倒序区间，某些引擎会直接失效）。
 */
const KEY_CHAR = 'A-Za-z0-9_.\\-'

/**
 * 从任意文本里提取 API Key。
 *
 * 用户手写/复制的文件经常带上 BOM、`API Key:` 标签、引号、中文说明甚至整段
 * Cookie 头，所以这里做**宽容提取**：优先认 `sk-` 开头的 token，其次认一个
 * 干净的裸 token；顺手把写进去的业务空间 ID 也捞出来。
 */
export function extractCredentials(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const wsMatch = source.match(new RegExp(`(?:workspace|业务空间)\\s*_?id?\\s*[:：=]\\s*([${KEY_CHAR}]{6,40})`, 'i'))
  const keyMatch = source.match(new RegExp(`sk-[${KEY_CHAR}]{10,}`))
  let apiKey = keyMatch !== null ? keyMatch[0] : ''
  if (apiKey.length === 0) {
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.replace(/^\uFEFF/, '').trim().replace(/^["'`]|["'`]$/g, '').trim()
      if (new RegExp(`^[${KEY_CHAR}]{20,}$`).test(line) && !/^\d+$/.test(line)) {
        apiKey = line
        break
      }
    }
  }
  return { apiKey, workspaceId: wsMatch !== null ? wsMatch[1] : '' }
}

/**
 * 解析有效密钥：调用参数 > 配置 > 密钥文件 > 环境变量。
 *
 * 返回 `{ apiKey, workspaceId, source }`；`source` 只说"从哪来"，不含值。
 */
export async function resolveCredentials({ callKey = '', config = {}, env = process.env } = {}) {
  const configWs = String(config?.workspaceId ?? '').trim()
  const fromCall = extractCredentials(callKey)
  if (fromCall.apiKey.length > 0) {
    return { apiKey: fromCall.apiKey, workspaceId: fromCall.workspaceId || configWs, source: 'call' }
  }
  const fromConfig = extractCredentials(config.apiKey ?? '')
  if (fromConfig.apiKey.length > 0) {
    return { apiKey: fromConfig.apiKey, workspaceId: fromConfig.workspaceId || configWs, source: 'config' }
  }
  const keyFile = String(config.keyFile ?? '').trim()
  if (keyFile.length > 0) {
    try {
      const text = await readFile(resolvePath(keyFile), 'utf8')
      const fromFile = extractCredentials(text)
      if (fromFile.apiKey.length > 0) {
        return { apiKey: fromFile.apiKey, workspaceId: fromFile.workspaceId || configWs, source: `file:${keyFile}` }
      }
      return { apiKey: '', workspaceId: '', source: `file:${keyFile}`, error: '密钥文件里没找到 sk- 开头的 Key（文件里是否只有说明文字？）' }
    } catch (error) {
      return { apiKey: '', workspaceId: '', source: `file:${keyFile}`, error: `密钥文件读取失败：${redact(error?.message)}` }
    }
  }
  const fromEnv = extractCredentials(env?.DASHSCOPE_API_KEY ?? '')
  if (fromEnv.apiKey.length > 0) {
    return { apiKey: fromEnv.apiKey, workspaceId: fromEnv.workspaceId || configWs, source: 'env' }
  }
  return { apiKey: '', workspaceId: '', source: 'none' }
}

/** 相对路径按 cwd 解析，绝对路径原样返回。 */
export const resolvePath = (p) => (isAbsolute(String(p)) ? String(p) : resolve(process.cwd(), String(p)))

/**
 * 拼出请求根地址。
 *
 * 优先级：显式 `baseUrl` > 有业务空间 ID 时的专属域名 > 老域名。
 * 地域必须与 key 一致——这是官方反复强调的硬约束，所以地域是必填概念。
 */
export function resolveBaseUrl(config = {}) {
  const explicit = String(config.baseUrl ?? '').trim()
  if (explicit.length > 0) return explicit.replace(/\/+$/, '')
  const region = String(config.region ?? 'cn-beijing').trim()
  const workspaceId = String(config.workspaceId ?? '').trim()
  const maas = MAAS_HOSTS[region]
  if (workspaceId.length > 0 && maas !== undefined) return maas.replace('{workspaceId}', workspaceId)
  return LEGACY_HOSTS[region] ?? LEGACY_HOSTS['cn-beijing']
}

// ---------------------------------------------------------------- 提示词

/**
 * 按 `kind` 组装设计提示词。
 *
 * 提示词是这套工具真正的资产：模型强在版式与文字渲染，但不会自己知道我们的
 * 设计意图，所以模板把"什么规格、什么状态、什么风格"写死成结构化清单，
 * 用户的 `prompt` 只负责填内容。好处是同一页面写两次能得到可比的草稿，
 * 迭代时也只有内容部分在变。
 */
export const PROMPT_TEMPLATES = {
  screen: {
    label: '整页 UI 布局',
    text: [
      '为网页产品生成一张高保真的前端界面视觉稿（UI mockup），要像真实产品截图，而不是概念插画。',
      '',
      '画布与栅格：正视图、无透视、无倾斜、无 3D 展示框、无设备外框（除非我明确要求）。',
      '结构：顶部导航 / 主内容区 / 侧栏 / 页脚按需求组织，留白均匀，对齐严格，间距遵循 8px 栅格。',
      '视觉：给出明确的配色方案（主色、辅助色、中性色阶）、字体层级（标题/正文/辅助文字的字号与字重）、圆角与阴影规则。',
      '细节：所有可见文字用中文，字号可读、不糊、不串行；按钮、输入框、卡片、列表、标签等组件画成最终形态。',
      '状态：至少体现默认态与一种强调态（如主按钮 hover、选中标签）。',
      '禁止：不要出现手机/笔记本等设备模型、不要设计师手绘标注、不要水印、不要无意义的英文假文。',
    ].join('\n'),
  },
  component: {
    label: '单个 UI 组件',
    text: [
      '生成一张 UI 组件的设计稿，单体展示，供前端实现时逐像素对照。',
      '',
      '画布：纯色中性背景（浅灰或深灰），组件居中，四周留出足够边距，不裁切。',
      '规格：标注组件尺寸（宽×高，px）、圆角半径、内边距、描边宽度、字体字号字重。',
      '状态：必须画出全部交互状态——默认、悬停、按下、聚焦、禁用、加载中（若适用），一字排开或成列，每个状态旁标注状态名。',
      '配色：给出色值（十六进制），并说明与主色的关系。',
      '文字：组件内文字用中文，清晰锐利、不糊、不换行错位。',
      '禁止：不要设备外框、不要透视、不要装饰性插画、不要水印。',
    ].join('\n'),
  },
  icon: {
    label: '图标 / 小元素',
    text: [
      '生成一组图标设计稿：同一套视觉语言，线宽一致、圆角一致、视觉重量一致，网格对齐。',
      '',
      '画布：纯色背景，图标等距成网格排列，每个图标下方标注其名称（中文）。',
      '风格：简洁、几何化、可在 24px 下辨识；若适用，线框与填充两种变体各出一列。',
      '禁止：不要文字标语、不要杂乱装饰、不要水印。',
    ].join('\n'),
  },
  flow: {
    label: '多屏流程',
    text: [
      '生成一张多屏流程设计稿：同一产品的连续若干屏并排展示，屏与屏之间视觉一致（同一套栅格、配色、组件）。',
      '',
      '排布：从左到右按使用顺序排列，屏之间留白，每屏旁标注步骤序号与一句话说明（中文）。',
      '每一屏都是完整界面正视图，无透视、无设备外框。',
      '禁止：不要手绘箭头涂鸦、不要水印、不要无意义假文。',
    ].join('\n'),
  },
  asset: {
    label: '图像素材 / 插画',
    text: [
      '生成一张用于界面的图像素材（插画 / 背景 / 空状态配图），风格统一、构图留白，便于叠加文字。',
      '',
      '要求：主体明确、背景干净、色彩与产品调性一致；若是空状态插画则采用扁平或轻质感风格。',
      '禁止：不要出现任何文字、不要水印。',
    ].join('\n'),
  },
  free: {
    label: '自由发挥',
    text: '按下面的描述生成图像。',
  },
}

/**
 * 合成最终提示词：模板骨架 + 设计对象 + 需求描述 + 风格 + 约束 + 禁止项。
 *
 * `style` / `constraints` / `negative` 是"上一轮反馈"的载体：用户看完 v01 说的
 * "主色太冷"、"按钮太大"，落在这些字段里，而不必重写整段提示词。
 */
export function composePrompt({ kind = 'screen', prompt = '', title = '', style = '', constraints = [], negative = '' } = {}) {
  const template = PROMPT_TEMPLATES[kind] ?? PROMPT_TEMPLATES.free
  const parts = [template.text.trim()]
  const head = String(title ?? '').trim()
  const body = String(prompt ?? '').trim()
  if (head.length > 0) parts.push(`【设计对象】${head}`)
  if (body.length > 0) parts.push(`【需求描述】\n${body}`)
  const styleText = String(style ?? '').trim()
  if (styleText.length > 0) parts.push(`【视觉风格】${styleText}`)
  const list = (Array.isArray(constraints) ? constraints : [constraints])
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0)
  if (list.length > 0) parts.push(`【必须遵守的约束】\n${list.map((entry) => `- ${entry}`).join('\n')}`)
  const negativeText = String(negative ?? '').trim()
  if (negativeText.length > 0) parts.push(`【必须避免】\n- ${negativeText}`)
  return parts.join('\n\n')
}

/** 默认反向提示词；画 UI 时最常见的几种翻车都在这儿挡住。 */
export function defaultNegativePrompt(kind) {
  const common = ['水印', '签名', '乱码文字', '文字重叠或错位', '低分辨率', '模糊', '过度锐化', '色彩溢出', '透视畸变', '拼接错位的重复元素']
  if (kind === 'screen' || kind === 'component' || kind === 'flow') {
    common.push('设备外框', '手机样机', '笔记本样机', '手绘标注箭头', '设计师草图质感', '无意义的英文假文')
  }
  return common.join('，')
}

// ------------------------------------------------------------------ 尺寸

/**
 * 计算输出尺寸：按画幅比在给定像素预算内取最大合规矩形。
 *
 * 三条硬约束来自官方文档：总像素 512²–2048²、单边 ≤2048、宽高比 1:8–8:1。
 * 边长为 16 的整数倍，面积保证不超预算（预算设置见 `AREA_BUDGET`），
 * 所以计费档可以放心用 `tierFor()` 实算。
 */
export function computeSize(aspect, quality = '1k') {
  const key = String(aspect ?? 'auto').trim()
  if (key === 'auto' || key === '') return null
  const ratio = ASPECT_RATIOS[key] ?? Number(key)
  if (!Number.isFinite(ratio) || ratio <= 0) return { width: 0, height: 0, aspect: key, error: `不认识的画幅比：${key}` }
  if (ratio > 8 || ratio < 1 / 8) return { width: 0, height: 0, aspect: key, error: `宽高比超限（1:8 ~ 8:1）：${key}` }
  const budget = AREA_BUDGET[quality] ?? AREA_BUDGET['1k']
  // 在 16 网格上全枚举（512–2048 步长 16，共 97 列），每列用比例算出最接近的高度。
  // 目标：面积尽量大、比例尽量准，且面积不超预算。全枚举比"理论解 + 附近微调"
  // 便宜得多也准得多——理论解 16:9 是 1526.49，向下对齐就丢到 1520，而 1536 那列
  // 其实是更好的解（只超预算 1.2%，所以确实该排除，但窄搜索会连 1520 的邻域都看漏）。
  //
  // 排序权重：比例误差第一优先（每 1% 误差罚 1% 预算面积），面积第二。
  // 反过来排会让 1:3 这种长条被"高度尽量接近理论值"带偏，挑出个比例严重失真的矩形。
  const candidates = []
  for (let w = MIN_SIDE_PX; w <= MAX_SIDE_PX; w += 16) {
    const h = clamp(roundTo(w / ratio, 16), MIN_SIDE_PX, MAX_SIDE_PX)
    const area = w * h
    if (area > budget || area < MIN_AREA_PX) continue
    const ratioError = Math.abs(w / h - ratio) / ratio
    candidates.push({ width: w, height: h, area, score: area - ratioError * budget })
  }
  if (candidates.length === 0) {
    const w = clamp(roundTo(Math.sqrt(budget * ratio), 16), MIN_SIDE_PX, MAX_SIDE_PX)
    const h = clamp(roundTo(w / ratio, 16), MIN_SIDE_PX, MAX_SIDE_PX)
    return { width: 0, height: 0, aspect: key, error: `画幅 ${key} 在 ${quality} 预算下找不到合法尺寸（试算 ${w}×${h}，面积 ${w * h}）` }
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  const area = best.area
  const width = best.width
  const height = best.height
  return { width, height, aspect: key, area }
}

/**
 * 判断某画幅在给定档位下能否真正达到该计费档。
 *
 * 极端的宽条/竖条（2:1、3:1、21:9 等）受"单边 ≤2048"限制，最大面积只有 180–210 万像素，
 * 物理上跨不过 225 万的 2K 阈值。这种情况不该假装买到了 2K——工具会如实告诉用户
 * "你选了 2k，但这个画幅最高只能到 1K 档"，而不是默默按 1K 出图却收了 2K 的钱。
 */
export function achievableTier(aspect, quality = '1k') {
  if (String(aspect) === 'auto') return 'unknown'
  const computed = computeSize(aspect, quality)
  if (computed === null || computed.error !== undefined) return 'unknown'
  return tierFor(computed.width, computed.height)
}

/** 像素面积 → 计费档（`1k` / `2k`）。 */
export const tierFor = (width, height) => (width * height > TIER_THRESHOLD_PX ? '2k' : '1k')

/** 单次调用的估算费用（元）。 */
export function estimateCost(region, width, height, { inputImages = 0, n = 1 } = {}) {
  const table = PRICING[region] ?? PRICING['cn-beijing']
  const tier = tierFor(width, height)
  const perImage = tier === '2k' ? table.out2k : table.out1k
  return Number((perImage * n + inputImages * table.input).toFixed(4))
}

// ------------------------------------------------------------ 请求体组装

/** 把本地图片字节转成 DashScope 可接受的 data URL。 */
export const toDataUrl = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

/** 魔数嗅探图片类型；不认识的返回空串。 */
export function sniffImageMime(bytes) {
  const buf = Buffer.from(bytes ?? [])
  for (const entry of MIME_BY_MAGIC) {
    if (buf.length < entry.bytes.length) continue
    if (!entry.bytes.every((byte, index) => buf[index] === byte)) continue
    if (entry.mime === 'image/webp' && !(buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP')) continue
    return entry.mime
  }
  return ''
}

/**
 * 读一张本地参考图并转成 data URL，逐条落实官方限制：
 * 大小 ≤10MB、格式在支持列表内。
 */
export async function loadReferenceImage(filePath) {
  const abs = resolvePath(filePath)
  let info
  try {
    info = await stat(abs)
  } catch {
    return { ok: false, error: `参考图不存在或不可读：${abs}` }
  }
  if (!info.isFile()) return { ok: false, error: `参考图不是文件：${abs}` }
  if (info.size > MAX_INPUT_BYTES) {
    return { ok: false, error: `参考图超过 10MB 上限（${(info.size / 1048576).toFixed(1)}MB）：${abs}` }
  }
  const bytes = await readFile(abs)
  const mime = sniffImageMime(bytes)
  if (mime.length === 0) return { ok: false, error: `参考图格式不在支持列表（JPG/PNG/BMP/TIFF/WEBP/GIF）：${abs}` }
  return { ok: true, path: abs, name: basename(abs), mime, bytes: info.size, dataUrl: toDataUrl(bytes, mime) }
}

/** 归一化参考图入参：字符串或 `{path|url|dataUrl}` 数组 → 统一图片项列表。 */
export function normalizeReferences(reference) {
  const list = reference === undefined || reference === null ? [] : Array.isArray(reference) ? reference : [reference]
  const items = []
  for (const entry of list) {
    if (entry === undefined || entry === null) continue
    if (typeof entry === 'string') {
      const value = entry.trim()
      if (value.length === 0) continue
      if (/^https?:\/\//i.test(value)) items.push({ kind: 'url', value })
      else if (/^data:image\//i.test(value)) items.push({ kind: 'dataUrl', value })
      else items.push({ kind: 'path', value })
      continue
    }
    if (typeof entry !== 'object') continue
    if (typeof entry.url === 'string' && entry.url.trim().length > 0) items.push({ kind: 'url', value: entry.url.trim() })
    else if (typeof entry.path === 'string' && entry.path.trim().length > 0) items.push({ kind: 'path', value: entry.path.trim() })
    else if (typeof entry.dataUrl === 'string' && entry.dataUrl.trim().length > 0) items.push({ kind: 'dataUrl', value: entry.dataUrl.trim() })
  }
  return items
}

/**
 * 组请求体。
 *
 * - `mode: 'async'` → 3.0 系列异步创建端点（配 `X-DashScope-Async: enable`）
 * - `mode: 'sync'` → 原生同步端点
 * - `mode: 'openai'` → OpenAI 兼容端点（参数平铺、`宽x高`、扩展字段在顶层）
 *
 * I2I 的 `content` 数组按官方示例把图片放前、text 放后。
 */
export function buildRequest({ mode = 'async', model = 'qwen-image-3.0-pro', prompt, imageItems = [], params = {} } = {}) {
  const size = params.size
  const n = positiveInt(params.n, 1, 1, 6)
  const negatives = String(params.negative ?? '').trim()
  const seedValue = params.seed === undefined || params.seed === null || params.seed === '' ? undefined : positiveInt(params.seed, 0, 0, 2147483647)
  if (mode === 'openai') {
    const body = {
      model,
      prompt: String(prompt ?? ''),
      n,
      ...(size === undefined || size === null || size === '' ? {} : { size: String(size).replace('*', 'x') }),
      ...(negatives.length > 0 ? { negative_prompt: negatives } : {}),
      ...(seedValue === undefined ? {} : { seed: seedValue }),
      prompt_extend: params.promptExtend !== false,
      enable_thinking: params.enableThinking !== false,
      watermark: params.watermark === true,
    }
    if (imageItems.length === 1) body.image = imageItems[0].value
    else if (imageItems.length > 1) body.image = imageItems.map((item) => item.value)
    return body
  }
  return {
    model,
    input: {
      messages: [{ role: 'user', content: [...imageItems.map((item) => ({ image: item.value })), { text: String(prompt ?? '') }] }],
    },
    parameters: {
      n,
      ...(size === undefined || size === null || size === '' ? {} : { size: String(size).replace('x', '*') }),
      prompt_extend: params.promptExtend !== false,
      enable_thinking: params.enableThinking !== false,
      watermark: params.watermark === true,
      ...(negatives.length > 0 ? { negative_prompt: negatives } : {}),
      ...(seedValue === undefined ? {} : { seed: seedValue }),
    },
  }
}

/** 按 API 形状决定实际请求地址。 */
export function endpointFor(baseUrl, mode) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  if (mode === 'openai') return `${base}/compatible-mode/v1/images/generations`
  if (mode === 'sync') return `${base}/api/v1/services/aigc/multimodal-generation/generation`
  return `${base}${ASYNC_CREATE_PATH}`
}

/** 任务查询地址。 */
export const taskEndpoint = (baseUrl, taskId) =>
  `${String(baseUrl ?? '').replace(/\/+$/, '')}${TASK_PATH.replace('{taskId}', encodeURIComponent(String(taskId)))}`

// ------------------------------------------------------------ 响应解析

/** 从异步创建响应里取 task_id。 */
export function parseTaskCreate(json) {
  const output = json?.output ?? json
  const taskId = output?.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return { ok: false, error: '响应里没有 task_id', code: json?.code, message: json?.message }
  }
  return { ok: true, taskId, status: output?.task_status ?? 'UNKNOWN', requestId: json?.request_id }
}

/** 从任务查询响应里取状态与图片 URL 列表。 */
export function parseTaskResult(json) {
  const output = json?.output ?? {}
  const usage = json?.usage ?? output?.usage ?? null
  const choices = output?.choices
  let actualPrompt
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const content = choice?.message?.content
      if (!Array.isArray(content)) continue
      for (const item of content) if (typeof item?.actual_prompt === 'string') actualPrompt = item.actual_prompt
    }
  }
  return {
    status: String(output?.task_status ?? 'UNKNOWN'),
    images: collectImageUrls(output),
    requestId: json?.request_id,
    code: output?.code ?? json?.code,
    message: output?.message ?? json?.message,
    usage,
    actualPrompt,
  }
}

/** 同步 / OpenAI 兼容两种形状统一抽出图片 URL。 */
export function parseSyncResult(json) {
  return {
    images: collectImageUrls(json),
    requestId: json?.request_id ?? null,
    code: json?.code ?? json?.error?.code,
    message: json?.message ?? json?.error?.message,
    errorParam: json?.error?.param ?? null,
    usage: json?.usage ?? null,
  }
}

/** 递归找出响应里所有像图片地址的字符串。 */
export function collectImageUrls(node, out = []) {
  if (Array.isArray(node)) {
    for (const entry of node) collectImageUrls(entry, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && value.length > 0) {
      if (key === 'image') out.push(value)
      else if (key === 'url' && /^https?:\/\//i.test(value)) out.push(value)
      else if (value.startsWith('http')) collectImageUrls({ url: value }, out)
    } else if (value !== null && typeof value === 'object') collectImageUrls(value, out)
  }
  return out
}

/** 业务错误码 → 可操作的中文说明。 */
export function explainError(code, message) {
  const table = {
    InvalidApiKey: 'API Key 无效：确认 key 与地域匹配、复制完整（注意首尾空格/换行）',
    InvalidParameter: '参数不被接受：检查 size 格式（原生用 `宽*高`，OpenAI 兼容用 `宽x高`）、n 是否为整数',
    Throttling: '触发限流（该模型 RPM 5）：降低频率后重试',
    'Throttling.RateQuota': '超过配额限流：稍后重试或申请提额',
    ModelNotExist: '模型名不存在或该地域未部署：确认模型名与地域',
    DataInspectionFailed: '内容审核未通过：调整提示词，避免违规内容',
    Arrearage: '账户欠费：充值后重试',
    'InvalidParameter.DataInspection': '输入图片或提示词未通过内容审核',
    InternalError: '服务端内部错误：重试即可，失败的调用不计费',
  }
  const key = String(code ?? '').trim()
  const hint = table[key]
  if (hint !== undefined) return `${key}：${hint}`
  if (key.length === 0) return redact(message ?? '未知错误')
  return `${key}：${redact(message ?? '（无详情）')}`
}

// -------------------------------------------------------------------- HTTP

/** 默认单次请求超时，毫秒。 */
const DEFAULT_TIMEOUT = 60000

/** 值得重试的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 指数退避：1s、2s、4s… 上限 16s；有 Retry-After 时听它的。 */
export function backoffMs(attempt, retryAfterHeader = null) {
  const header = Number(retryAfterHeader)
  if (Number.isFinite(header) && header > 0) return Math.min(60000, header * 1000)
  return Math.min(16000, 1000 * 2 ** attempt)
}

/**
 * 一条 JSON POST。密钥只在这里拼进请求头，绝不放 body。
 * 5xx 与 429 自动指数退避重试（RPM 5 撞限流是常态，不是异常）。
 */
export async function postJson(url, { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT, retries = 0, fetchImpl = fetch, onWait = null, sleepImpl = sleep } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      lastError = new Error(`请求失败：${redact(error?.message ?? error)}`)
      if (attempt < retries) {
        const wait = backoffMs(attempt)
        if (onWait !== null) onWait(wait, attempt + 1)
        await sleepImpl(wait)
        continue
      }
      throw lastError
    }
    clearTimeout(timer)
    const text = await response.text().catch(() => '')
    let json = null
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (response.ok && json !== null) return { status: response.status, json, headers: response.headers }
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      const wait = backoffMs(attempt, response.headers?.get?.('retry-after'))
      if (onWait !== null) onWait(wait, attempt + 1)
      await sleepImpl(wait)
      continue
    }
    const code = json?.code ?? json?.error?.code ?? `HTTP ${response.status}`
    const message = json?.message ?? json?.error?.message ?? (text.length > 0 ? text.slice(0, 400) : '（空响应体）')
    const error = new Error(explainError(code, message))
    error.status = response.status
    error.payload = json
    throw error
  }
  throw lastError ?? new Error('请求失败')
}

/** GET 一个 JSON（任务查询）。 */
export async function getJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const text = await response.text().catch(() => '')
    let json = null
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      const code = json?.code ?? `HTTP ${response.status}`
      const message = json?.message ?? text.slice(0, 400)
      const error = new Error(explainError(code, message))
      error.status = response.status
      throw error
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轮询任务直到出结果。
 *
 * 超时**不算失败**：任务可能还在跑，把 task_id 交回用户，凭它 24 小时内可续查。
 */
export async function pollTask(taskId, options = {}) {
  const {
    baseUrl,
    headers = {},
    intervalMs = 3000,
    timeoutMs = 300000,
    fetchImpl = fetch,
    onTick = null,
    now = () => Date.now(),
    sleepImpl = sleep,
  } = options
  const started = now()
  const url = taskEndpoint(baseUrl, taskId)
  let polls = 0
  for (;;) {
    polls++
    const json = await getJson(url, { headers, fetchImpl })
    const result = parseTaskResult(json)
    if (onTick !== null) onTick({ polls, status: result.status, elapsedSec: Math.round((now() - started) / 1000) })
    if (result.status === 'SUCCEEDED') {
      return { ok: true, images: result.images, status: result.status, waitedMs: now() - started, polls, requestId: result.requestId, usage: result.usage, actualPrompt: result.actualPrompt }
    }
    if (result.status === 'FAILED' || result.status === 'CANCELED') {
      return { ok: false, images: [], status: result.status, waitedMs: now() - started, polls, requestId: result.requestId, error: explainError(result.code, result.message) }
    }
    if (now() - started + intervalMs > timeoutMs) {
      return {
        ok: false,
        pending: true,
        images: [],
        status: result.status,
        waitedMs: now() - started,
        polls,
        taskId,
        requestId: result.requestId,
        error: `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，任务仍在队列中（task_id 有效 24 小时，可用它继续查询）`,
      }
    }
    await sleepImpl(intervalMs)
  }
}

/** 下载图片字节；失败时抛出带说明的错误。 */
export async function downloadImage(url, { timeoutMs = 120000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal })
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 1024) throw new Error(`下载到的图片过小（${bytes.length} 字节），疑似失败`)
    if (sniffImageMime(bytes) === '') throw new Error('下载到的内容不是可识别的图片')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ 落盘

/** 确保目录存在。 */
export const ensureDir = async (dir) => {
  await mkdir(dir, { recursive: true })
  return dir
}

/** 目录里已有的最大版本号 + 1。 */
export async function nextVersion(dir) {
  const { readdir } = await import('node:fs/promises')
  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    return 1
  }
  let max = 0
  for (const entry of entries) {
    const m = entry.match(/^v(\d{1,3})\.(png|json)$/i)
    if (m === null) continue
    max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** `3` → `v03`。 */
export const versionTag = (n) => `v${String(n).padStart(2, '0')}`

// ------------------------------------------------------- PNG 说明图（无依赖）

/** CRC32（PNG 每个 chunk 都要）。 */
function crc32(buf) {
  let table = crc32.table
  if (table === undefined) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    crc32.table = table
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG chunk。 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/** 5×7 点阵字模，覆盖 ASCII 32–126；每字符 7 行，每行低 5 位有效。 */
const FONT_5X7 = {
  ' ': '00 00 00 00 00 00 00', '!': '04 04 04 04 04 00 04', '"': '0A 0A 00 00 00 00 00',
  '#': '0A 1F 0A 0A 1F 0A 00', '$': '04 0F 14 0E 05 1E 04', '%': '18 19 02 04 08 13 03',
  '&': '0C 12 14 08 15 12 0D', "'": '04 04 00 00 00 00 00', '(': '02 04 08 08 08 04 02',
  ')': '08 04 02 02 02 04 08', '*': '00 0A 04 1F 04 0A 00', '+': '00 04 04 1F 04 04 00',
  ',': '00 00 00 00 0C 04 08', '-': '00 00 00 1F 00 00 00', '.': '00 00 00 00 00 0C 0C',
  '/': '01 02 02 04 08 08 10', '0': '0E 11 13 15 19 11 0E', '1': '04 0C 04 04 04 04 0E',
  '2': '0E 11 01 02 04 08 1F', '3': '1F 02 04 02 01 11 0E', '4': '02 06 0A 12 1F 02 02',
  '5': '1F 10 1E 01 01 11 0E', '6': '06 08 10 1E 11 11 0E', '7': '1F 01 02 04 08 08 08',
  '8': '0E 11 11 0E 11 11 0E', '9': '0E 11 11 0F 01 02 0C', ':': '00 0C 0C 00 0C 0C 00',
  ';': '00 0C 0C 00 0C 04 08', '<': '02 04 08 10 08 04 02', '=': '00 00 1F 00 1F 00 00',
  '>': '08 04 02 01 02 04 08', '?': '0E 11 01 02 04 00 04', '@': '0E 11 17 15 17 10 0E',
  A: '0E 11 11 1F 11 11 11', B: '1E 11 11 1E 11 11 1E', C: '0E 11 10 10 10 11 0E',
  D: '1C 12 11 11 11 12 1C', E: '1F 10 10 1E 10 10 1F', F: '1F 10 10 1E 10 10 10',
  G: '0E 11 10 17 11 11 0F', H: '11 11 11 1F 11 11 11', I: '0E 04 04 04 04 04 0E',
  J: '07 02 02 02 02 12 0C', K: '11 12 14 18 14 12 11', L: '10 10 10 10 10 10 1F',
  M: '11 1B 15 15 11 11 11', N: '11 11 19 15 13 11 11', O: '0E 11 11 11 11 11 0E',
  P: '1E 11 11 1E 10 10 10', Q: '0E 11 11 11 15 12 0D', R: '1E 11 11 1E 14 12 11',
  S: '0F 10 10 0E 01 01 1E', T: '1F 04 04 04 04 04 04', U: '11 11 11 11 11 11 0E',
  V: '11 11 11 11 11 0A 04', W: '11 11 11 15 15 1B 11', X: '11 11 0A 04 0A 11 11',
  Y: '11 11 0A 04 04 04 04', Z: '1F 01 02 04 08 10 1F', '[': '0E 08 08 08 08 08 0E',
  '\\': '10 08 08 04 02 02 01', ']': '0E 02 02 02 02 02 0E', '^': '04 0A 11 00 00 00 00',
  _: '00 00 00 00 00 00 1F', '`': '08 04 00 00 00 00 00', '{': '02 04 04 08 04 04 02',
  '|': '04 04 04 04 04 04 04', '}': '08 04 04 02 04 04 08', '~': '00 00 09 16 00 00 00',
}

const GLYPH_W = 6
const GLYPH_H = 8

/** 渲染一行 ASCII 文本到位图（就地写像素）。 */
function drawText(pixels, width, x0, y0, text, scale, color) {
  let x = x0
  for (const rawChar of String(text)) {
    const char = rawChar.toUpperCase()
    const rows = (FONT_5X7[char] ?? FONT_5X7['?']).split(' ')
    for (let gy = 0; gy < 7; gy++) {
      const bits = parseInt(rows[gy], 16)
      for (let gx = 0; gx < 5; gx++) {
        if ((bits & (1 << (4 - gx))) === 0) continue
        for (let sy = 0; sy < scale; sy++) {
          const py = y0 + gy * scale + sy
          if (py < 0) continue
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx
            if (px < 0 || px >= width) continue
            const index = (py * width + px) * 4
            if (index < 0 || index + 3 >= pixels.length) continue
            pixels[index] = color[0]
            pixels[index + 1] = color[1]
            pixels[index + 2] = color[2]
            pixels[index + 3] = 255
          }
        }
      }
    }
    x += GLYPH_W * scale
  }
}

/** 把 RGBA 像素编码成 PNG（只用 zlib，无第三方依赖）。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/**
 * 生成一张"只含 ASCII 的说明图"。
 *
 * 为什么需要：提示词本身没法在画布里复现，而 5×7 点阵画不出汉字（没有字库，
 * 画出来是乱码）。所以做法是在图上方贴一条纯 ASCII 信息条——模型名、画幅、
 * 尺寸、版本、时间——把图单独贴到别处时，看的人一眼知道这是哪个版本、什么规格。
 * 中文信息不丢：它在配套的 `<version>.json` 与目录 `README.md` 里。
 */
export function renderBannerPng({ width = 1280, lines = [], background = [17, 19, 23], foreground = [235, 238, 245], accent = [120, 200, 255] }) {
  const clean = lines.map((line) => String(line ?? '')).filter((line) => line.length > 0)
  const scale = Math.max(2, Math.round(width / 420))
  const lineHeight = GLYPH_H * scale + Math.round(scale * 5)
  const padding = Math.round(scale * 6)
  const height = Math.max(1, padding * 2 + clean.length * lineHeight)
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = background[0]
    pixels[i * 4 + 1] = background[1]
    pixels[i * 4 + 2] = background[2]
    pixels[i * 4 + 3] = 255
  }
  clean.forEach((line, index) => drawText(pixels, width, padding, padding + index * lineHeight, line, scale, index === 0 ? accent : foreground))
  return encodePng(width, height, pixels)
}

/** 图片尺寸（PNG/JPEG/GIF/BMP 头部即可判定，够用且零依赖）。 */
export function readImageSize(bytes) {
  const buf = Buffer.from(bytes ?? [])
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buf[offset + 1]
      const length = buf.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), format: 'jpeg' }
      }
      offset += 2 + length
    }
    return null
  }
  if (buf.length > 10 && buf.slice(0, 3).toString('ascii') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' }
  }
  if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), format: 'bmp' }
  }
  return null
}

// ------------------------------------------------------------------ 元数据

/**
 * 迭代链的完整记录。
 *
 * 这是"用户预览 → 提建议 → 重做"这条循环的账本：每个版本都留下提示词、
 * 参考图来源、seed、request_id、费用。没有它，第三轮就想不起来第一轮到底
 * 改了什么，也没法解释"为什么这张不能用"。
 */
export function buildVersionMeta(input) {
  const {
    version, kind, title, prompt, userPrompt, model, region, aspect, size, n, seed,
    promptExtend, enableThinking, watermark, negative, references, basedOn, taskId,
    requestId, apiMode, width, height, bytes, elapsedSec, costCny, outputs,
    workspaceRoot, files, createdAt, actualPrompt, promptSource,
  } = input ?? {}
  return {
    schema: 'dsh-design-sketch/version@1',
    version: versionTag(version),
    versionNumber: version,
    createdAt: createdAt ?? isoLocal(),
    kind,
    title,
    prompt,
    // 提示词来源：`template` = 模板自动合成；`user-reviewed` = 用户审过并改过的那一版。
    // 记下来是为了回答"这张图当时到底发了什么、是谁定的" —— 出问题时这是第一手证据。
    promptSource: promptSource ?? 'template',
    ...(typeof actualPrompt === 'string' && actualPrompt.length > 0 ? { actualPrompt } : {}),
    userPrompt: String(userPrompt ?? ''),
    model,
    region,
    apiMode,
    request: {
      aspect,
      size,
      n,
      seed: seed ?? null,
      promptExtend: promptExtend !== false,
      enableThinking: enableThinking !== false,
      watermark: watermark === true,
      negative,
      references: (references ?? []).map((item) => ({ kind: item.kind, name: item.name ?? null, source: item.described ?? item.value })),
      basedOn: basedOn ?? null,
    },
    taskId: taskId ?? null,
    requestId: requestId ?? null,
    // 实际计费档由落盘图片的真实像素面积算出：请求 2k 但画幅跨不过 225 万阈值时会落到 1k，
    // 元数据必须如实记录，否则事后对账会以为按 2K 收了钱。
    result: { width, height, bytes, outputs: outputs ?? 1, elapsedSec, costCny, tier: width > 0 && height > 0 ? tierFor(width, height) : null },
    files: files ?? {},
    workspaceRoot: workspaceRoot ?? null,
  }
}

/** 由版本元数据生成一行紧凑摘要（目录 README 表格用）。 */
export function versionSummaryLine(meta) {
  const size = meta?.result?.width !== undefined ? `${meta.result.width}×${meta.result.height}` : '—'
  const refs = meta?.request?.references?.length ?? 0
  const mode = refs > 0 ? `I2I(${refs}图)` : 'T2I'
  return `| ${meta.version} | ${mode} | ${meta.request?.aspect ?? '—'} | ${size} | ${meta.request?.seed ?? '—'} | ¥${meta.result?.costCny ?? '—'} | ${meta.result?.elapsedSec ?? '—'}s |`
}

// -------------------------------------------------------------------- 路径

/**
 * 解析输出根目录。
 *
 * 不用 `process.cwd()` 做基准：DSH 是长驻进程，cwd 是启动目录而不是会话工作区
 * （bili-notes 正因此必须显式配 outputDir）。所以这里要求显式配置，未配置时
 * **明确报错**，而不是悄悄写到某个猜出来的位置。
 */
export function resolveOutputRoot(config = {}) {
  const configured = String(config.outputDir ?? '').trim()
  if (configured.length === 0) return { ok: false, error: '未配置 outputDir，无法确定设计图落盘位置' }
  return { ok: true, root: resolvePath(configured) }
}

/** 设计目录名：`<安全标题>_<日期>`；同标题同日期复用同一目录，形成迭代链。 */
export const designDirName = (title, now = new Date()) => `${safeName(title, 'design')}_${dateStamp(now)}`

/** 由工作区根与绝对路径算 Markdown 里用的相对路径。 */
export function relativeForMarkdown(absPath, workspaceRoot) {
  if (workspaceRoot === undefined || workspaceRoot === null || String(workspaceRoot).length === 0) return toPosix(absPath)
  const rel = relativeInside(String(workspaceRoot), String(absPath))
  return rel === null ? toPosix(absPath) : toPosix(rel)
}

/** 计算 `abs` 相对 `root` 的路径；不在 root 内时返回 null。 */
function relativeInside(root, abs) {
  const normRoot = resolve(root).replace(/[\\/]+$/, '')
  const normAbs = resolve(abs)
  if (normAbs === normRoot) return ''
  if (!normAbs.startsWith(normRoot + sep)) return null
  return normAbs.slice(normRoot.length + 1)
}

export { join, dirname, basename, writeFile }
