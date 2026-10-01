/**
 * dsh-design-sketch — 前端 UI 设计生图（host 插件）。
 *
 * 注册模型工具 `design_sketch`：按设计意图生成 UI 效果图（整页布局 / 单个组件 /
 * 图标 / 多屏流程 / 图像素材），把图与元数据落到工作目录，供用户预览；用户提
 * 完反馈后，用 `reviseOf` 以上一版为参考图走图生图（I2I）局部改，而不是重新抽卡。
 * 页面与组件都能用——单个按钮也有 `kind: "component"` + 状态清单模板。
 *
 * 默认平台是阿里云百炼的 `qwen-image-3.0-pro`（华北2 北京），主路走原生异步接口
 * （建任务 + 轮询），备选原生同步与 OpenAI 兼容形状。
 *
 * 隐私：API Key 只进 HTTP 请求头，绝不进入落盘文件、工具结果、错误信息或日志。
 *
 * @module dsh-design-sketch
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  KIND_DEFAULT_ASPECT,
  MODELS,
  PROMPT_TEMPLATES,
  buildRequest,
  buildVersionMeta,
  composePrompt,
  computeSize,
  defaultNegativePrompt,
  designDirName,
  downloadImage,
  endpointFor,
  ensureDir,
  estimateCost,
  explainError,
  isoLocal,
  loadReferenceImage,
  nextVersion,
  normalizeReferences,
  parseSyncResult,
  parseTaskCreate,
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
  resolvePath,
  tierFor,
  versionSummaryLine,
  versionTag,
} from './core.mjs'
import { auditLossless } from './guard.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-design-sketch'

/** 本插件依赖的 DSH 服务。 */
export const inject = ['tools', 'systemPrompt']

/** 设计目录里的索引文件名。 */
const INDEX_FILE = 'README.md'

/** 凭据类失败的统一指路语（首次使用最常见的故障）。 */
const KEY_HINT =
  '修法：把 DashScope API Key 存成一行文本放进配置项 `keyFile` 指向的文件（例如 `C:\\Users\\gaoze\\.dsh\\dashscope-key.txt`，内容只有 `sk-...`），或设置环境变量 `DASHSCOPE_API_KEY`。注意 key 必须与配置的地域一致（北京/新加坡的 key 不通用），且不要带引号或换行以外的字符。'

/** 画幅比白名单（用于参数说明，避免把内部表全暴露给模型）。 */
const ASPECT_CHOICES = '16:9 / 9:16 / 4:3 / 3:4 / 1:1 / 3:2 / 2:3 / 21:9 / 2:1 / 1:2 / 3:1 / 1:3 / auto'

export const Config = z.object({
  apiKey: z.string().default(''),
  keyFile: z.string().default(''),
  workspaceId: z.string().default(''),
  region: z.string().default('cn-beijing'),
  baseUrl: z.string().default(''),
  model: z.string().default('qwen-image-3.0-pro'),
  outputDir: z.string().default(''),
  workspaceRoot: z.string().default(''),
  apiMode: z.string().default('async'),
  quality: z.string().default('1k'),
  size: z.string().default(''),
  n: z.number().default(1),
  promptExtend: z.boolean().default(true),
  enableThinking: z.boolean().default(true),
  watermark: z.boolean().default(false),
  banner: z.boolean().default(false),
  timeoutMs: z.number().default(60000),
  retries: z.number().default(2),
  maxWaitMs: z.number().default(300000),
  pollIntervalMs: z.number().default(3000),
})

// ------------------------------------------------------------------ 小工具

const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

/** 归一化数组入参（单值 / 数组 / 逗号串都收）。 */
function toArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter((entry) => entry.length > 0)
  const text = String(value).trim()
  if (text.length === 0) return []
  return text.split(/[\n,，、]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/**
 * 递归剥掉对象里值为 `undefined` 的键（数组里的 `undefined` 直接丢弃）。
 *
 * **这不是洁癖，是硬要求**：harness 拒绝任何"不是无损 JSON"的工具结果，而一个值为
 * `undefined` 的属性正好就是 —— 它会让整次调用以
 * `tool "x" returned invalid output: value is not lossless JSON` 失败，
 * 哪怕图已经成功生成并落盘。工具结果由一堆可选片段拼成（`seed`、`requestId`、
 * `taskId`、`basedOn` 都可能缺），所以整个返回值在交出前必须过这一层。
 *
 * 注意 `null` 要保留：它表示"明确没有"，与"没这个字段"语义不同
 * （例如 `basedOn: null` 表示这是首版而非改图）。
 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== undefined).map((entry) => stripUndefined(entry))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = stripUndefined(entry)
  }
  return out
}

/** 自检日志：只在自检发现违规时才会写内容，平时是个零字节文件。 */
const AUDIT_LOG = 'delivery-audit.log'

/** 版本戳：用于确认真机上跑的到底是哪一份代码。 */
const MARKER = 'design-sketch/2026-09-30T22:50'

/**
 * 把一行诊断写到 `<outputDir>/delivery-audit.log`。
 *
 * 用文件副作用而非返回值来留痕：真机拒收工具结果时，返回值根本传不出来，
 * 只有写盘能证明"这一段代码被执行过、跑的是哪个版本"。
 */
async function probe(stage, config, detail = '') {
  try {
    const dir = String(config?.outputDir ?? '').trim()
    if (dir.length === 0) return
    await ensureDir(dir)
    await appendFile(join(dir, AUDIT_LOG), `${isoLocal()}  [${stage}] ${detail}\n`, 'utf8')
  } catch {
    /* 探针写不进去也不能影响工具本身 */
  }
}

/**
 * 交付工具结果：先按 DSH 的规则自检，再用 JSON 往返物化成"外来的纯对象"。
 *
 * **为什么必须这么绕**：真机上曾出现 `tool "design_sketch" returned invalid output:
 * value is not lossless JSON`，而离线同进程复现永远通过 —— 差异在运行环境（跨 realm /
 * 代理对象），不在数据形状。JSON 往返是唯一能同时消灭"undefined 字段、类实例原型、
 * 重复引用、非纯原型"的手段：它交给调用方的必然是一个全新的 Object.prototype 对象，
 * 不可能被判定成类实例。这不是容错，是把不确定性彻底消掉。
 *
 * 自检发现违规时写日志而不是抛错：图已经生成并落盘，为一条日志把整次调用判死
 * 才是真的用户体验事故。
 */
async function deliver(payload, { auditDir = null, stage = 'result' } = {}) {
  const stripped = stripUndefined(payload)
  const verdict = auditLossless(stripped)
  if (!verdict.ok) {
    const line = `${isoLocal()}  [${stage}] 自检 FAIL @ ${verdict.path} — ${verdict.reason}\n`
    if (auditDir !== null) {
      try {
        await appendFile(join(auditDir, AUDIT_LOG), line, 'utf8')
      } catch {
        /* 日志写不进去也不能影响交付 */
      }
    }
  }
  let materialized = stripped
  try {
    materialized = JSON.parse(JSON.stringify(stripped))
  } catch {
    /* 极端情况（BigInt 之类）走原值，交由 DSH 报错 */
  }
  const after = auditLossless(materialized)
  if (!after.ok && auditDir !== null) {
    try {
      await appendFile(join(auditDir, AUDIT_LOG), `${isoLocal()}  [${stage}] 物化后仍 FAIL @ ${after.path} — ${after.reason}\n`, 'utf8')
    } catch {
      /* 同上 */
    }
  }
  return materialized
}

/** 版本目录里已有的版本元数据（按版本号升序）。 */
async function readVersionChain(designDir) {
  const { readdir } = await import('node:fs/promises')
  let entries = []
  try {
    entries = await readdir(designDir)
  } catch {
    return []
  }
  const versions = []
  for (const entry of entries) {
    const m = entry.match(/^v(\d{1,3})\.json$/i)
    if (m === null) continue
    let meta = null
    try {
      meta = JSON.parse(await readFile(join(designDir, entry), 'utf8'))
    } catch {
      meta = null
    }
    versions.push({ version: Number(m[1]), file: join(designDir, entry), meta })
  }
  return versions.sort((a, b) => a.version - b.version)
}

/**
 * 解析 `reviseOf`：可以是 `v02` / `2`，也可以是相对/绝对图片路径。
 * 返回基础图的绝对路径；解析不到时给出人话解释（含该目录现有版本清单）。
 */
async function resolveBaseImage(designDir, reviseOf) {
  const raw = String(reviseOf ?? '').trim()
  if (raw.length === 0) return { ok: true, path: null }
  const version = parseVersion(raw)
  const looksLikePath = /[\\/]/.test(raw) || /\.(png|jpe?g|webp|bmp|gif|tiff)$/i.test(raw)
  if (version !== null && !looksLikePath) {
    const target = join(designDir, `${versionTag(version)}.png`)
    try {
      const bytes = await readFile(target)
      if (bytes.length > 0) return { ok: true, path: target, version }
    } catch {
      const chain = await readVersionChain(designDir)
      const hint =
        chain.length > 0
          ? `该目录现有版本：${chain.map((entry) => entry.meta?.version ?? versionTag(entry.version)).join('、')}`
          : '该目录还没有任何版本'
      return { ok: false, error: `${target} 不存在。${hint}` }
    }
  }
  const abs = resolvePath(raw)
  try {
    const bytes = await readFile(abs)
    if (bytes.length > 0) return { ok: true, path: abs }
  } catch {
    /* 落到下面的报错 */
  }
  return { ok: false, error: `reviseOf 既不是已有版本号也不是可读文件：${raw}` }
}

/** 重建目录索引（覆盖式重写，保证与目录内容一致）。 */
async function writeIndex(designDir, title, kind) {
  const chain = await readVersionChain(designDir)
  const lines = [
    `# ${title}`,
    '',
    `> 由 DSH 插件 \`dsh-design-sketch\` 生成的设计稿集合。类型：${kind}（${PROMPT_TEMPLATES[kind]?.label ?? kind}）。`,
    '> 同一目录下的 `v01`、`v02`… 是同一条迭代链；元数据里 `request.basedOn` 指向的那一版就是本版的参考图。',
    '',
  ]
  if (chain.length === 0) {
    lines.push('_暂无版本。_', '')
  } else {
    lines.push('| 版本 | 模式 | 画幅 | 尺寸 | seed | 估算费用 | 耗时 |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const entry of chain) {
      lines.push(entry.meta === null ? `| v${String(entry.version).padStart(2, '0')} | — | — | — | — | — | — |` : versionSummaryLine(entry.meta))
    }
    lines.push('')
    const latest = chain[chain.length - 1]
    if (latest.meta !== null) {
      lines.push('## 最新一版', '', `- 用户需求：${latest.meta.userPrompt || '（未填写）'}`)
      const basedOn = latest.meta.request?.basedOn
      if (basedOn !== null && basedOn !== undefined) lines.push(`- 基于：${basedOn}`)
      lines.push(`- 图片：\`${latest.meta.version}.png\``, '')
      lines.push('<details><summary>完整提示词</summary>', '', '```text', String(latest.meta.prompt ?? ''), '```', '', '</details>', '')
    }
  }
  await writeFile(join(designDir, INDEX_FILE), lines.join('\n'), 'utf8')
  return join(designDir, INDEX_FILE)
}

/** 把失败现场写进目录，保留可追溯性（也便于事后诊断）。 */
async function writeFailureMeta(designDir, payload) {
  try {
    const version = await nextVersion(designDir)
    const target = join(designDir, `${versionTag(version)}.failed.json`)
    await writeFile(target, JSON.stringify({ ...payload, version: versionTag(version), createdAt: isoLocal() }, null, 2), 'utf8')
    return target
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 调用模型

/**
 * 按指定 API 形状发一次请求，返回统一的 `{ ok, images, requestId, taskId, usage, actualPrompt, error }`。
 *
 * 请求体按形状现算：原生用嵌套 `input.messages` + `宽*高`，OpenAI 兼容用平铺
 * `prompt` + `宽x高`。两者是同一份参数的两种写法，所以只在发请求那一刻定型，
 * 避免"降级到另一种形状却仍发旧形状的 body"这类错。
 */
async function callOnce({ mode, config, credentials, params, onTick }) {
  const baseUrl = resolveBaseUrl({ ...config, workspaceId: credentials.workspaceId || config.workspaceId })
  const url = endpointFor(baseUrl, mode)
  const headers = { Authorization: `Bearer ${credentials.apiKey}` }
  const retries = Math.max(0, Math.floor(Number(config.retries) || 0))
  const timeoutMs = Math.max(5000, Math.floor(Number(config.timeoutMs) || 60000))
  const body = buildRequest({
    mode: mode === 'openai' ? 'openai' : 'native',
    model: params.model,
    prompt: params.promptText,
    imageItems: params.imageItems,
    params: params.request,
  })

  if (mode === 'async') {
    const created = await postJson(url, {
      headers: { ...headers, 'X-DashScope-Async': 'enable' },
      body,
      retries,
      timeoutMs,
      onWait: (ms, attempt) => onTick?.(`撞限流或服务端抖动，第 ${attempt} 次重试前等 ${Math.round(ms / 1000)}s`),
    })
    const parsed = parseTaskCreate(created.json)
    if (!parsed.ok) {
      return {
        ok: false,
        fatal: true,
        protocolMismatch: created.status === 404 || created.status === 405,
        images: [],
        error: explainError(created.json?.code ?? 'InvalidResponse', created.json?.message ?? parsed.error),
        requestId: created.json?.request_id,
      }
    }
    onTick?.(`任务已受理（task_id=${parsed.taskId}），开始轮询…`)
    const polled = await pollTask(parsed.taskId, {
      baseUrl,
      headers,
      intervalMs: Math.max(1000, Math.floor(Number(config.pollIntervalMs) || 3000)),
      timeoutMs: Math.max(30000, Math.floor(Number(config.maxWaitMs) || 300000)),
      onTick: (info) => onTick?.(`第 ${info.polls} 次查询：${info.status}（已等 ${info.elapsedSec}s）`),
    })
    if (polled.pending === true) {
      return {
        ok: false,
        fatal: false,
        pending: true,
        images: [],
        taskId: parsed.taskId,
        requestId: polled.requestId ?? parsed.requestId,
        error: polled.error,
        waitedMs: polled.waitedMs,
        polls: polled.polls,
      }
    }
    if (!polled.ok) {
      return {
        ok: false,
        fatal: true,
        images: [],
        error: polled.error,
        requestId: polled.requestId ?? parsed.requestId,
        taskId: parsed.taskId,
        waitedMs: polled.waitedMs,
        polls: polled.polls,
      }
    }
    return {
      ok: true,
      images: polled.images,
      requestId: polled.requestId ?? parsed.requestId,
      taskId: parsed.taskId,
      usage: polled.usage,
      actualPrompt: polled.actualPrompt,
      waitedMs: polled.waitedMs,
      polls: polled.polls,
    }
  }

  const response = await postJson(url, {
    headers,
    body,
    retries,
    timeoutMs,
    onWait: (ms, attempt) => onTick?.(`第 ${attempt} 次重试前等 ${Math.round(ms / 1000)}s`),
  })
  const parsed = parseSyncResult(response.json)
  if (parsed.images.length === 0) {
    return {
      ok: false,
      fatal: true,
      protocolMismatch: response.status === 404 || response.status === 405,
      images: [],
      error: explainError(parsed.code ?? 'InvalidResponse', parsed.message ?? '响应里没有图片地址'),
      requestId: parsed.requestId,
    }
  }
  return { ok: true, images: parsed.images, requestId: parsed.requestId, usage: parsed.usage }
}

/**
 * 按 `apiMode` 依次尝试。
 *
 * `auto` = 异步 → 同步 → OpenAI 兼容：只在"形状不被接受"（协议层 404/405）时换
 * 下一种。鉴权、审核、欠费一律直接返回——那些错误换形状也救不回来，继续试只会
 * 浪费用户的时间和额度。
 */
async function callModel({ config, credentials, params, onTick }) {
  const configured = String(config.apiMode ?? 'async').trim().toLowerCase()
  const order = configured === 'auto' ? ['async', 'sync', 'openai'] : [configured]
  const attempts = []
  for (let index = 0; index < order.length; index++) {
    const mode = order[index]
    const more = index < order.length - 1
    try {
      const result = await callOnce({ mode, config, credentials, params, onTick })
      if (result.ok || result.pending === true) return { ...result, apiMode: mode, attempts }
      attempts.push({ mode, error: result.error })
      if (more && result.protocolMismatch === true) {
        onTick?.(`${mode} 形状不被接受（${result.error}），改用 ${order[index + 1]} 形状重试`)
        continue
      }
      return { ...result, apiMode: mode, attempts }
    } catch (error) {
      const status = Number(error?.status)
      const message = redact(error?.message ?? error)
      attempts.push({ mode, error: message })
      if (more && (status === 404 || status === 405)) {
        onTick?.(`${mode} 形状返回 HTTP ${status}，改用 ${order[index + 1]} 形状重试`)
        continue
      }
      return { ok: false, fatal: true, images: [], error: message, apiMode: mode, attempts }
    }
  }
  const last = attempts[attempts.length - 1]
  return { ok: false, fatal: true, images: [], error: last?.error ?? '所有调用形状都失败了', attempts }
}

// ------------------------------------------------------------------ 工具面

/**
 * 组装模型工具（导出以便测试与复用）。
 *
 * 参数刻意做得"会自己补默认值"：agent 只需要给 `title` + `prompt`，
 * `kind` 决定模板，`aspect` 缺省时按 `kind` 取默认画幅，`size`/`n`/`model` 全部兜底。
 */
export function createTool(ctx, config) {
  const outputRootResult = resolveOutputRoot(config)
  const outputRoot = outputRootResult.ok ? outputRootResult.root : ''
  const workspaceRoot = isNonEmpty(config.workspaceRoot)
    ? resolvePath(config.workspaceRoot)
    : outputRootResult.ok
      ? dirname(outputRoot)
      : ''
  const bannerEnabled = config.banner === true
  const defaultModel = isNonEmpty(config.model) ? String(config.model).trim() : 'qwen-image-3.0-pro'

  /** 失败返回要用到的状态，放在 createTool 作用域里。 */
  const state = { workspaceRoot, model: defaultModel, apiMode: String(config.apiMode) }

  /** 统一的失败返回：给 agent 可执行的下一步，而不是一句"失败了"。 */
  async function fail(message, extra = {}) {
    const rows = [message]
    // 鉴权类失败如果不告诉人去哪儿配 key，agent 只能原地打转。这是最常见的
    // 首次使用故障（key 没配 / 配错地域 / 少了 sk- 前缀），所以补一句指路。
    const authenticationTrouble = /InvalidApiKey|API Key|密钥|Unauthorized|401/i.test(message)
    const hint = isNonEmpty(extra.hint) ? extra.hint : authenticationTrouble ? KEY_HINT : ''
    if (hint.length > 0) rows.push('', hint)
    if (Array.isArray(extra.attempts) && extra.attempts.length > 0) {
      rows.push('', '各调用形状的尝试结果：')
      for (const attempt of extra.attempts) rows.push(`- ${attempt.mode}：${attempt.error}`)
    }
    if (Array.isArray(extra.files) && extra.files.filter(Boolean).length > 0) {
      rows.push('', `相关文件：${extra.files.filter(Boolean).map((p) => `\`${p}\``).join('、')}`)
    }
    // fail() 自身不是 async，但它的调用点都在 async 的 execute 里，返回值就是 Promise。
    return await deliver({
      ok: false,
      stage: 'failed',
      designDir: extra.files?.[0] ?? '',
      workspaceRoot: state.workspaceRoot,
      version: '—',
      kind: extra.kind ?? 'unknown',
      title: extra.title ?? '生成失败',
      mode: 'T2I',
      model: state.model,
      apiMode: state.apiMode,
      aspect: '—',
      size: '—',
      elapsedSec: 0,
      estimatedCostCny: 0,
      imagePaths: [],
      metaPath: '',
      indexPaths: [],
      content: [{ type: 'text', text: redact(rows.join('\n')) }],
    })
  }
  return defineTool({
    name: 'design_sketch',
    description: [
      '生成前端 UI 设计效果图（T2I）或基于参考图改图（I2I），并把 PNG 与元数据落到工作目录，供用户预览。',
      '**必须先出提示词草稿让用户过目**：先用 `askOnly: true` 调用——它会返回完整的提示词与反向提示词、不生成图片、不花钱；把提示词原样贴给用户，问他要不要改、要不要换一版，等他明确同意后再去掉 `askOnly` 真正出图。',
      '四种用法：① 首次出图，先 `askOnly: true` 看稿 → 用户确认后去掉它生成；② 用户提了修改意见，传 reviseOf="v01" 以上一版为参考图局部改（整体不变，只改指定处）；③ 手上有截图/竞品图，用 reference 传本地路径或 URL 出变体；④ 用户改过提示词，用 `promptOverride` 把改完的完整文案传回落下去。',
      'kind 决定提示词模板与默认画幅：screen（整页布局）/ component（单个组件含全部交互状态，做按钮就选它）/ icon / flow（多屏流程）/ asset（插画素材）/ free。',
      '注意：生成一张通常 1-3 分钟；想在图顶部加版本信息条用 banner。返回正文含图片相对路径，可直接展示给用户。',
      '**用户没有明确同意之前，不要跳过草稿直接生成。**',
    ].join(''),
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '设计对象的名字，同时用作目录名与图内信息条，如「专辑详情页」。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '需求描述：这个页面/组件要有什么、内容是什么、强调什么。不用写画幅与规格（模板会自动补）。',
      },
      kind: {
        type: 'string',
        description: `设计类型，默认 screen。可选：${Object.keys(PROMPT_TEMPLATES).join(' / ')}。`,
      },
      aspect: {
        type: 'string',
        description: `画幅比，默认按 kind 取（screen=16:9、component=1:1、flow=21:9）。可选 ${ASPECT_CHOICES}。`,
      },
      style: {
        type: 'string',
        description: '视觉风格一句话，如「暗色、玻璃拟态、圆角 12px」。',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: '必须遵守的约束清单，例如「主色 #3B82F6」「不要侧栏」。',
      },
      negative: {
        type: 'string',
        description: '必须避免的内容；不填则按 kind 用内置反向提示词。',
      },
      reference: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图：本地文件路径或公网 URL，最多 3 张（传了就是 I2I）。本地图自动转 base64 上传。',
      },
      reviseOf: {
        type: 'string',
        description: '以上一版为基础改：填版本号（"v01" / "2"）或图片路径。做局部修改而不是重新生成。',
      },
      size: {
        type: 'string',
        description: '显式指定输出尺寸，格式 `宽*高`（如 1536*864）。留空则按 aspect + quality 自动算。',
      },
      quality: {
        type: 'string',
        description: '画幅档位：1k（约 ¥0.25/张）或 2k（约 ¥0.5/张），默认 1k。',
      },
      n: {
        type: 'integer',
        description: '出图张数，1-6，默认 1。要多方案对比时才调大（每张都计费）。',
      },
      seed: {
        type: 'integer',
        description: '固定随机种子，便于在保持风格的前提下微调提示词。',
      },
      model: {
        type: 'string',
        description: `模型名，默认取配置（${defaultModel}）。可选：${Object.keys(MODELS).join(' / ')}。`,
      },
      banner: {
        type: 'boolean',
        description: '是否在图上方加一条英文信息条（模型/画幅/尺寸/版本/时间），默认跟随配置（默认关）。',
      },
      designDir: {
        type: 'string',
        description: '显式指定设计目录名；留空则用 `<title>_<日期>`。同一目录下的多个版本构成迭代链。',
      },
      askOnly: {
        type: 'boolean',
        description:
          '只出提示词草稿、不出图、不收费。先用它把提示词原样交给用户确认或修改，拿到明确同意后再去掉它去生成。**用户没点头之前不要去掉。**',
      },
      promptOverride: {
        type: 'string',
        description:
          '用户改过的完整提示词。传了它就不再套模板、直接原样使用——用于把"用户审完稿的最终文案"落下去。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stage: { type: 'string', required: true, enum: ['draft', 'generated', 'failed', 'pending'] },
          designDir: { type: 'string', required: true },
          workspaceRoot: { type: 'string', required: true },
          version: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['screen', 'component', 'icon', 'flow', 'asset', 'free', 'unknown'] },
          title: { type: 'string', required: true },
          mode: { type: 'string', required: true, enum: ['T2I', 'I2I'] },
          model: { type: 'string', required: true },
          apiMode: { type: 'string', required: true, enum: ['async', 'sync', 'openai', 'auto'] },
          aspect: { type: 'string', required: true },
          size: { type: 'string', required: true },
          seed: { type: 'integer' },
          elapsedSec: { type: 'integer', required: true },
          estimatedCostCny: { type: 'number', required: true },
          imageTier: { type: 'string', enum: ['1k', '2k'] },
          notes: { type: 'string' },
          imagePaths: { type: 'array', required: true, items: { type: 'string' } },
          metaPath: { type: 'string', required: true },
          indexPaths: { type: 'array', required: true, items: { type: 'string' } },
          requestId: { type: 'string' },
          taskId: { type: 'string' },
          taskPending: { type: 'boolean' },
          basedOn: { type: 'string' },
          promptDraft: { type: 'string' },
          negativeDraft: { type: 'string' },
          content: { type: 'json', required: true },
        },
      },
      render: (_args, value) => value.content,
    },
    timeoutMs: Math.max(180000, Math.floor(Number(config.maxWaitMs) || 300000) + 120000),
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `生成设计稿：${String(args?.title ?? '').slice(0, 40)}`,
      kind: 'write',
    }),
    presentResult: (_args, result) => ({ card: 'generic', title: `设计稿 ${String(result?.version ?? '')}`, kind: 'write' }),

    async execute(args) {
      const startedAt = Date.now()
      void probe('execute', config, `title=${String(args?.title ?? '')} marker=${MARKER}`)
      const notes = []
      const onTick = (message) => {
        const text = redact(message)
        if (notes.length === 0 || notes[notes.length - 1] !== text) notes.push(text)
      }

      const title = String(args?.title ?? '').trim()
      const userPrompt = String(args?.prompt ?? '').trim()
      const kind = (() => {
        const raw = String(args?.kind ?? 'screen').trim().toLowerCase()
        return PROMPT_TEMPLATES[raw] !== undefined ? raw : 'screen'
      })()
      if (title.length === 0) return await fail('缺少 title：请给这个设计对象起个名字', { kind, title: '参数不完整' })
      if (userPrompt.length === 0) return await fail('缺少 prompt：请描述这个设计要什么', { kind, title })

      // 落盘位置
      if (!outputRootResult.ok) {
        return await fail('未配置 outputDir：请在插件配置里指定设计图落盘根目录（例如 <你的工作区>\\demo\\design）', {
          kind,
          title,
          hint: 'DSH 是长驻进程，cwd 不是会话工作区，所以这里要求显式配置而不是猜一个位置。',
        })
      }
      const dirName = String(args?.designDir ?? '').trim() || designDirName(title)
      const designDir = join(outputRoot, dirName)
      await ensureDir(designDir)
      // 提前取出：草稿闸门要用它判断 T2I / I2I，生成路径也要用它读上一版图
      const reviseRaw = String(args?.reviseOf ?? '').trim()

      // 密钥
      const credentials = await resolveCredentials({ callKey: args?.apiKey ?? '', config })
      if (credentials.apiKey.length === 0) {
        const detail = isNonEmpty(credentials.error) ? credentials.error : `未找到可用密钥（查找来源：${credentials.source}）`
        return await fail(`没有可用的 DashScope API Key：${detail}`, {
          kind,
          title,
          hint: '把 key 存成一行文本放进密钥文件（配置项 keyFile），或设置环境变量 DASHSCOPE_API_KEY。',
          files: [designDir],
        })
      }

      // 参数兜底
      const model = isNonEmpty(args?.model) ? String(args.model).trim() : defaultModel
      state.model = model
      state.apiMode = String(config.apiMode)
      const knownModel = MODELS[model]
      const negative = isNonEmpty(args?.negative) ? String(args.negative).trim() : defaultNegativePrompt(kind)
      // 提示词：默认由模板合成；`promptOverride` 用来落"用户改过的那一版"。
      // 这条路径的存在意义 —— 用户看完草稿改了词，工具必须能**原样**使用它，
      // 而不是又拿模板把改动覆盖掉。
      const promptText = isNonEmpty(args?.promptOverride)
        ? String(args.promptOverride).trim()
        : composePrompt({
            kind,
            prompt: userPrompt,
            title,
            style: args?.style,
            constraints: toArray(args?.constraints),
            negative,
          })
      const quality = String(args?.quality ?? config.quality ?? '1k').toLowerCase() === '2k' ? '2k' : '1k'
      const aspect = isNonEmpty(args?.aspect) ? String(args.aspect).trim() : KIND_DEFAULT_ASPECT[kind] ?? '16:9'

      // 尺寸先算出来：草稿与生成两条路径共用同一个结果，用户看到的尺寸就是最终出图的尺寸。
      const configSize = isNonEmpty(config.size) ? String(config.size).trim().replace('x', '*') : ''
      let sizeText = isNonEmpty(args?.size) ? String(args.size).trim().replace('x', '*') : configSize
      let pixelWidth = 0
      let pixelHeight = 0
      if (sizeText.length === 0 && aspect !== 'auto') {
        const computed = computeSize(aspect, quality)
        if (computed !== null && computed.error !== undefined) return await fail(`画幅参数不被接受：${computed.error}`, { kind, title })
        if (computed !== null) {
          sizeText = `${computed.width}*${computed.height}`
          pixelWidth = computed.width
          pixelHeight = computed.height
        }
      } else if (sizeText.length > 0) {
        const m = sizeText.match(/^(\d{2,4})\s*\*\s*(\d{2,4})$/)
        if (m === null) return await fail(`size 格式不对：${sizeText}（应为 \`宽*高\`，如 1536*864）`, { kind, title })
        pixelWidth = Number(m[1])
        pixelHeight = Number(m[2])
        if (pixelWidth < 512 || pixelHeight < 512 || pixelWidth > 2048 || pixelHeight > 2048) {
          return await fail(`size 超出允许范围：单边需在 512–2048（收到 ${pixelWidth}×${pixelHeight}）`, { kind, title })
        }
      }

      // ─────────────────────────────────────────────────────────────────
      // 草稿闸门：只把提示词交回去，**不花一分钱**
      //
      // 为什么要有这一步：以前工具被调用就直接出图，用户根本没机会在"钱花出去之前"
      // 看一眼究竟发了什么提示词。现在 agent 必须先走 `askOnly: true`，
      // 把提示词原样贴给用户确认或修改，拿到明确答复后才真正生成。
      //
      // 放在密钥检查**之前**：光看提示词不需要密钥，没配 key 也能先审稿。
      // ─────────────────────────────────────────────────────────────────
      if (args?.askOnly === true) {
        const resetNote = isNonEmpty(args?.promptOverride)
          ? '本次使用的是**你（或用户）改过的提示词**，不再套用模板。'
          : '以下提示词由模板自动合成，可以直接改任意一句后再生成。'
        const preview = [
          '## 提示词草稿（尚未生成，未计费）',
          '',
          `- 设计对象：**${title}**（${kind}｜${PROMPT_TEMPLATES[kind]?.label ?? kind}）`,
          `- 画幅与尺寸：${aspect}｜${sizeText || '由模型自选'}｜档位 ${quality}（约 ${quality === '2k' ? '¥0.5' : '¥0.25'}/张）`,
          `- 模型：${model}｜地域：${config.region}`,
          resetNote.length > 0 ? `- ${resetNote}` : '',
          '',
          '```text',
          promptText,
          '```',
          '',
          '### 反向提示词（告诉模型"不要画什么"）',
          '',
          '```text',
          negative,
          '```',
          '',
          '**下一步（给 agent 的操作指引）**',
          '',
          '1. 把上面这段提示词**原样**展示给用户，并问一句：就按这个生成吗？要改哪一句？',
          '2. 用户要改 → 按他的意思改好文案后，用 `promptOverride` 传回**改完的完整提示词**再调用（可带 `askOnly: true` 再确认一轮）。',
          '3. 用户要想挑一版 → 用不同的 `style` / `constraints` 再调几次 `askOnly: true`，把几版并排给用户选（这一步不花钱）。',
          '4. 用户确认后 → 去掉 `askOnly` 直接调用，工具会真正出图（此时才计费）。',
          '5. **用户没有明确同意之前，不要去掉 `askOnly` 去生成。**',
        ]
          .filter((line) => line !== '')
          .join('\n')

        return await deliver(
          {
            ok: true,
            stage: 'draft',
            designDir,
            workspaceRoot,
            version: '—',
            kind,
            title,
            mode: reviseRaw.length > 0 ? 'I2I' : 'T2I',
            model,
            apiMode: String(config.apiMode),
            aspect,
            size: sizeText || 'auto',
            elapsedSec: 0,
            estimatedCostCny: 0,
            promptDraft: promptText,
            negativeDraft: negative,
            basedOn: reviseRaw.length > 0 ? reviseRaw : undefined,
            imagePaths: [],
            metaPath: '',
            indexPaths: [],
            content: [{ type: 'text', text: preview }],
          },
          { auditDir: designDir, stage: 'draft' },
        )
      }

      const n = Math.max(1, Math.min(6, Math.floor(Number(args?.n ?? config.n ?? 1) || 1)))

      // 模型能力先于参考图解析：这样"用纯文生图模型做 I2I"这类配置错误会在伸手
      // 读磁盘之前就被拦住，报错也更贴近真正的原因。
      if (knownModel !== undefined && knownModel.edit === false) {
        const wantsEdit = String(args?.reviseOf ?? '').trim().length > 0 || normalizeReferences(args?.reference).length > 0
        if (wantsEdit) {
          return await fail(`模型 ${model} 不支持图生图/图像编辑，请换 qwen-image-3.0-pro 或 qwen-image-3.0`, { kind, title })
        }
      }
      // 画幅与档位的实际关系：极端长条（2:1、3:1、21:9…）受"单边 ≤2048"限制，
      // 物理上跨不过 225 万像素阈值，买不到 2K 档。这种情况如实说明，不假装。
      let tierNote = ''
      if (pixelWidth === 0 && sizeText.length === 0) {
        tierNote = '输出尺寸由模型自选，实际档位与费用以模型返回的分辨率为准'
      } else if (pixelWidth > 0) {
        const actualTier = tierFor(pixelWidth, pixelHeight)
        if (actualTier !== quality) tierNote = `画幅 ${aspect} 下最高只能到 ${actualTier} 档（单边 ≤2048 的限制），已按 ${actualTier} 出图`
      }
      const effectiveQuality = pixelWidth > 0 ? tierFor(pixelWidth, pixelHeight) : quality

      // 参考图：reviseOf（本工具自己的迭代链）优先于 reference（外部图）
      const imageItems = []
      const refDescriptions = []
      let basedOn = null
      if (reviseRaw.length > 0) {
        const base = await resolveBaseImage(designDir, reviseRaw)
        if (!base.ok) return await fail(`reviseOf 解析失败：${base.error}`, { kind, title, files: [designDir] })
        const loaded = await loadReferenceImage(base.path)
        if (!loaded.ok) return await fail(`上一版图片无法读取：${loaded.error}`, { kind, title, files: [designDir] })
        imageItems.push({ kind: 'path', value: loaded.dataUrl })
        basedOn = base.version !== undefined ? versionTag(base.version) : base.path
        refDescriptions.push({ kind: 'basedOn', name: basename(base.path), described: basedOn })
        onTick(`以上一版 ${basedOn} 为参考图做局部修改`)
      } else {
        const refs = normalizeReferences(args?.reference)
        if (refs.length > 3) return await fail(`参考图最多 3 张，收到 ${refs.length} 张`, { kind, title })
        for (const ref of refs) {
          if (ref.kind === 'path') {
            const loaded = await loadReferenceImage(ref.value)
            if (!loaded.ok) return await fail(`参考图无法使用：${loaded.error}`, { kind, title })
            imageItems.push({ kind: 'path', value: loaded.dataUrl })
            refDescriptions.push({ kind: 'path', name: loaded.name, described: loaded.path })
          } else {
            imageItems.push({ kind: ref.kind, value: ref.value })
            refDescriptions.push({ kind: ref.kind, name: null, described: ref.kind === 'url' ? ref.value : '（内联 base64）' })
          }
        }
      }


      const seed =
        args?.seed === undefined || args?.seed === null || args?.seed === ''
          ? undefined
          : Math.max(0, Math.min(2147483647, Math.floor(Number(args.seed))))
      const useBanner = args?.banner === undefined ? bannerEnabled : args.banner === true
      const requestParams = {
        size: sizeText,
        n,
        negative,
        seed,
        promptExtend: config.promptExtend !== false,
        enableThinking: config.enableThinking !== false,
        watermark: config.watermark === true,
      }

      const call = await callModel({
        config,
        credentials,
        onTick,
        params: { model, promptText, imageItems, request: requestParams },
      })

      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      const mode = imageItems.length > 0 ? 'I2I' : 'T2I'

      if (!call.ok) {
        const failurePath = await writeFailureMeta(designDir, {
          kind,
          title,
          userPrompt,
          prompt: promptText,
          model,
          apiMode: call.apiMode,
          taskId: call.taskId ?? null,
          requestId: call.requestId ?? null,
          error: call.error,
          attempts: call.attempts ?? [],
          elapsedSec,
          pending: call.pending === true,
        })
        if (call.pending === true) {
          return deliver({
            ok: false,
            stage: 'pending',
            designDir,
            workspaceRoot,
            version: '—',
            kind,
            title,
            mode,
            model,
            apiMode: call.apiMode ?? String(config.apiMode),
            aspect,
            size: sizeText || 'auto',
            elapsedSec,
            estimatedCostCny: 0,
            imagePaths: [],
            metaPath: failurePath ?? '',
            indexPaths: [],
            taskPending: true,
            taskId: String(call.taskId ?? ''),
            content: [
              {
                type: 'text',
                text: [
                  '## 任务仍在队列中（超时未完成，**不是失败**）',
                  '',
                  `- 任务 ID：\`${call.taskId}\``,
                  `- 已等待：${elapsedSec}s（轮询 ${call.polls ?? '?'} 次）`,
                  `- 状态：${call.error ?? '未完成'}`,
                  '',
                  '`task_id` 有效 24 小时。可以稍后重跑（会新建任务、再计费一次），或先做别的事再回头查这个 id。',
                ].join('\n'),
              },
            ],
          }, { auditDir: designDir, stage: 'pending' })
        }
        return await fail(`生成失败：${call.error}`, { kind, title, files: [designDir, failurePath], attempts: call.attempts })
      }

      // 下载并落盘
      const version = await nextVersion(designDir)
      const tag = versionTag(version)
      const imagePaths = []
      const downloaded = []
      for (let index = 0; index < call.images.length; index++) {
        const suffix = call.images.length > 1 ? `-${index + 1}` : ''
        const target = join(designDir, `${tag}${suffix}.png`)
        try {
          let bytes = await downloadImage(call.images[index])
          if (useBanner) {
            const info = readImageSize(bytes)
            const bannerLines = [
              `${model}  ${sizeText || 'auto'}  ${aspect}`,
              `${tag}  ${title}`,
              `${isoLocal()}  seed=${seed ?? 'random'}  by dsh-design-sketch`,
            ]
            const bannerPng = renderBannerPng({ width: info !== null && info.width >= 640 ? info.width : 1280, lines: bannerLines })
            bytes = Buffer.concat([bannerPng, bytes])
          }
          const info = readImageSize(bytes)
          await writeFile(target, bytes)
          imagePaths.push(target)
          downloaded.push({ file: basename(target), bytes: bytes.length, width: info?.width ?? null, height: info?.height ?? null })
        } catch (error) {
          onTick(`第 ${index + 1} 张下载失败：${redact(error?.message ?? error)}`)
        }
      }

      if (imagePaths.length === 0) {
        const failurePath = await writeFailureMeta(designDir, {
          kind,
          title,
          userPrompt,
          prompt: promptText,
          model,
          apiMode: call.apiMode,
          requestId: call.requestId ?? null,
          taskId: call.taskId ?? null,
          error: '出图成功但下载全部失败（OSS 链接 24 小时过期或网络问题）',
          imageUrls: call.images,
          elapsedSec,
        })
        return await fail('模型出图成功，但图片下载全部失败（链接有效期 24 小时，也可能是网络问题）。稍后可重试。', {
          kind,
          title,
          files: [designDir, failurePath],
        })
      }

      const firstBytes = await readFile(imagePaths[0])
      const firstSize = readImageSize(firstBytes)
      const finalWidth = firstSize?.width ?? pixelWidth
      const finalHeight = firstSize?.height ?? pixelHeight
      const finalCost = estimateCost(config.region, finalWidth, finalHeight, { inputImages: imageItems.length, n: imagePaths.length })
      const metaPath = join(designDir, `${tag}.json`)
      const meta = buildVersionMeta({
        version,
        kind,
        title,
        prompt: promptText,
        userPrompt,
        promptSource: isNonEmpty(args?.promptOverride) ? 'user-reviewed' : 'template',
        actualPrompt: call.actualPrompt,
        model,
        region: config.region,
        apiMode: call.apiMode,
        aspect,
        size: sizeText || 'auto',
        n,
        seed,
        promptExtend: config.promptExtend !== false,
        enableThinking: config.enableThinking !== false,
        watermark: config.watermark === true,
        negative,
        references: refDescriptions,
        basedOn,
        taskId: call.taskId,
        requestId: call.requestId,
        width: finalWidth,
        height: finalHeight,
        bytes: firstBytes.length,
        elapsedSec,
        costCny: finalCost,
        outputs: imagePaths.length,
        workspaceRoot,
        quality: effectiveQuality,
        files: { images: imagePaths.map((p) => basename(p)), meta: basename(metaPath), index: INDEX_FILE },
      })
      meta.downloads = downloaded
      if (call.usage !== undefined && call.usage !== null) meta.usage = call.usage
      await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
      const indexPath = await writeIndex(designDir, title, kind)

      // 给 agent 的正文：相对路径用于内嵌预览，绝对路径用于其他工具
      const relImages = imagePaths.map((p) => relativeForMarkdown(p, workspaceRoot))
      const history = await readVersionChain(designDir)
      // CODE-MARKER-2B：用于确认"到底哪份代码在真机上执行"。若工具返回的正文里出现
      // 这行注释，说明运行时加载的是当前版本；不出现则说明 DSH 仍在跑缓存里的旧模块。
      const lines = [`<!-- CODE-MARKER-2B -->`, `## ${title} — ${tag}（${kind} / ${mode}）`, '']
      for (let index = 0; index < imagePaths.length; index++) {
        lines.push(`![${title} ${tag}${imagePaths.length > 1 ? ` 方案${index + 1}` : ''}](<${relImages[index]}>)`)
        lines.push('')
      }
      lines.push(
        [
          `- 版本：${tag}${basedOn !== null ? `（基于 ${basedOn} 改）` : ''}${history.length > 1 ? `｜本目录第 ${history.length} 版` : ''}`,
          `- 规格：${aspect}｜${finalWidth}×${finalHeight}｜seed ${seed ?? '随机'}｜${elapsedSec}s｜约 ¥${finalCost}`,
          `- 模型：${model}（${call.apiMode} 形状）｜地域：${config.region}`,
          `- 目录：\`${designDir}\``,
          `- 图片：\`${imagePaths[0]}\`${imagePaths.length > 1 ? `（共 ${imagePaths.length} 张）` : ''}`,
          `- 元数据：\`${metaPath}\`｜索引：\`${indexPath}\``,
        ].join('\n'),
      )
      lines.push('')
      lines.push(
        [
          '**下一步（给 agent 的操作指引，不必转述给用户）**',
          '',
          '1. 先把这张图展示给用户（内嵌预览或 `present` 文件卡片），**用户看到图之前不要开始写前端代码**。',
          `2. 用户说"改 X"时，用 \`reviseOf: "${tag}"\` 再调一次，并把改动写进 \`prompt\`——这样整体保持不变，只改指定处。`,
          `3. 用户说"重来一版"时不要传 \`reviseOf\`；想保持风格可带上本版 seed（${seed ?? '本版无固定种子'}）。`,
          `4. 计费口径：本版约 ¥${finalCost}（1K ¥0.25/张、2K ¥0.5/张，输入图 ¥0.02/张；模型 RPM 上限 5）。用户没要求图时不要调这个工具。`,
          '5. 设计图用于对齐方向的视觉参考，不是逐像素规格书：实现时以布局/配色/层级为准，细节按代码规范落地。',
        ].join('\n'),
      )
      if (notes.length > 0) {
        lines.push('', `<details><summary>执行过程（${notes.length} 步）</summary>`, '', ...notes.map((note) => `- ${note}`), '', '</details>')
      }

      return deliver({
        ok: true,
        stage: 'generated',
        designDir,
        workspaceRoot,
        version: tag,
        kind,
        title,
        mode,
        model,
        apiMode: call.apiMode,
        aspect,
        size: sizeText || 'auto',
        seed: seed === undefined ? undefined : seed,
        elapsedSec,
        estimatedCostCny: finalCost,
        imageTier: effectiveQuality,
        notes: tierNote,
        imagePaths,
        metaPath,
        indexPaths: [indexPath, metaPath],
        requestId: call.requestId === undefined || call.requestId === null ? undefined : String(call.requestId),
        taskId: call.taskId === undefined || call.taskId === null ? undefined : String(call.taskId),
        basedOn: basedOn === null ? undefined : basedOn,
        content: [{ type: 'text', text: lines.join('\n') }],
      }, { auditDir: designDir, stage: 'success' })
    },
  })
}

/** Cordis 插件入口。 */
export function apply(ctx, rawConfig) {
  const config = z.resolve(rawConfig ?? {}, Config, {})[0]
  const tool = createTool(ctx, config)

  // 装载探针：用文件副作用（而不是返回值）记录"这份代码被执行到了"。
  // 真机报 `value is not lossless JSON` 时，靠它区分"在跑旧模块"与"新代码也过不了"。
  probe('apply', config, `marker=${MARKER}`).catch(() => {})

  ctx.systemPrompt.section({
    name: 'tool:design_sketch',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH'),
    text: ({ scope }) =>
      ctx.tools.get('design_sketch', scope) === undefined
        ? ''
        : [
            '当任务涉及**前端界面设计**——新增一个页面、一个像样的 UI 组件（按钮、卡片、表单、空状态…），或用户明确说"先看效果图/设计稿"——先判断是否需要视觉基准，再决定要不要写代码。',
            '',
            '判定条件（不是每次都生成）：① 新增页面或新组件，且设计目录下没有同类基准图 → 生成；② 纯逻辑改动、改文案、改数据流，或已有基准图可参照 → 不生成；③ 用户明说"不用给我看图" → 不生成；④ 用户已有截图/竞品图 → 用 `reference` 直接出变体。',
            '',
            '**出图的固定两步流程（必须遵守）**：',
            '第一步——用 `askOnly: true` 调用 `design_sketch`：它只返回提示词与反向提示词，**不生成图片、不花钱**。把提示词**原样**贴给用户（用代码块，别改写），问一句「就按这个生成吗？哪句要改？」。',
            '用户想挑一版时，用不同的 `style` / `constraints` 多调几次 `askOnly: true`，把几版并排给他选——这一步同样不花钱。',
            '第二步——用户明确同意后，去掉 `askOnly` 再调用，此时才真正出图并计费。用户改过提示词的话，把他的最终文案用 `promptOverride` 传回去。',
            '**用户没有明确同意之前，绝不要跳过第一步直接生成**；也不要因为"用户可能觉得麻烦"就替他做决定。',
            '',
            '用户看过图之后：提修改意见就用 `reviseOf` 传上一版版本号做局部修改（而不是重新生成一版）。单个按钮这类小件同样适用：`kind: "component"` 会要求模型画出默认/悬停/按下/禁用等全部状态。',
            '',
            '生成一张通常 1-3 分钟、约 ¥0.25–0.5。工具返回的正文里带着图片相对路径，把它展示给用户之后再继续。',
          ].join('\n'),
  })

  ctx.tools.register(tool)
}
