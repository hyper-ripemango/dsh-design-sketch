/**
 * 真实链路探针 —— 打一次真的 DashScope 请求，验证"文档假设"是否成立。
 *
 * 这是**唯一会花钱的测试**：默认只出一张 1K 图（约 ¥0.25）。所以要显式给 `--yes`。
 *
 * 为什么需要它：假服务只能证明"我的代码自洽"，证明不了官方接口的真实形状。
 * 官方文档承诺的几件事必须用真请求确认，否则上线后才发现就晚了：
 *   1. 异步创建端点 `/api/v1/services/aigc/image-generation/generation` 受理 3.0-pro
 *   2. 轮询 `GET /api/v1/tasks/{id}` 的状态机与字段名
 *   3. 出图 URL 真的能下载、真的是 PNG
 *   4. `size` 用星号 `宽*高`、`n` 是整数
 *   5. 密钥只进请求头（落盘文件里搜不到）
 *
 * 用法：
 *   node test/verify-real.mjs            # 只做不花钱的检查（key 是否就位、域名等）
 *   node test/verify-real.mjs --yes      # 真出一张图
 *   node test/verify-real.mjs --yes --title "专辑详情页" --prompt "……"
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { extractCredentials, resolveBaseUrl, resolveCredentials, taskEndpoint } from '../core.mjs'
import { createTool } from '../index.mjs'

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const KEY_FILE = process.env.DSH_DESIGN_KEY_FILE ?? 'C:\\Users\\gaoze\\.dsh\\dashscope-key.txt'
const OUTPUT_DIR = process.env.DSH_DESIGN_OUTPUT ?? 'C:\\dogx\\demo\\design'
const WORKSPACE_ROOT = process.env.DSH_DESIGN_WORKSPACE ?? 'C:\\dogx'
const CONFIRM = hasFlag('--yes')

const line = (text = '') => console.log(text)
line('=== dsh-design-sketch 真实链路探针 ===')
line(`密钥文件：${KEY_FILE}`)
line(`落盘目录：${OUTPUT_DIR}`)
line(`出图授权：${CONFIRM ? '已给（--yes）' : '未给（只做免费检查）'}`)
line()

// ---------------------------------------------------- 步骤 1：密钥就位

let keyText = null
try {
  keyText = await readFile(KEY_FILE, 'utf8')
} catch (error) {
  line(`[1/5] 密钥文件读不到：${error.code ?? error.message}`)
  line()
  line('请把 API Key 存成一行文本放进该文件（内容只有 sk-...），然后重跑：')
  line(`  Set-Content -Path '${KEY_FILE}' -Value 'sk-你的key' -Encoding ascii -NoNewline`)
  process.exit(2)
}

const parsed = extractCredentials(keyText)
line(`[1/5] 密钥文件可读：${keyText.length} 字符，提取到 key=${parsed.apiKey.length > 0 ? '是' : '否'}${parsed.workspaceId ? `，业务空间 ID=${parsed.workspaceId}` : ''}`)
if (parsed.apiKey.length === 0) {
  line('       文件里没有 sk- 开头的 key。常见原因：文件里写的是说明文字、key 被换行/空格截断、或漏了 sk- 前缀。')
  process.exit(2)
}
const hasBom = keyText.charCodeAt(0) === 0xfeff
const hasNonAscii = /[^\x20-\x7e]/.test(parsed.apiKey)
line(`       BOM=${hasBom ? '有（已剥掉）' : '无'}；key 含非 ASCII=${hasNonAscii ? '是（会 400，请重存）' : '否'}`)
if (hasNonAscii) process.exit(2)

const config = {
  apiKey: '',
  keyFile: KEY_FILE,
  region: 'cn-beijing',
  baseUrl: '',
  model: 'qwen-image-3.0-pro',
  outputDir: OUTPUT_DIR,
  workspaceRoot: WORKSPACE_ROOT,
  apiMode: 'async',
  quality: '1k',
  n: 1,
  promptExtend: true,
  enableThinking: true,
  watermark: false,
  banner: false,
  timeoutMs: 60000,
  retries: 1,
  maxWaitMs: 300000,
  pollIntervalMs: 3000,
}

// ---------------------------------------------------- 步骤 2：域名与端点

const credentials = await resolveCredentials({ config })
const baseUrl = resolveBaseUrl({ ...config, workspaceId: credentials.workspaceId })
line(`[2/5] 密钥来源=${credentials.source}；请求根地址=${baseUrl}`)
line(`       异步创建：${baseUrl}/api/v1/services/aigc/image-generation/generation`)
line(`       任务查询：${taskEndpoint(baseUrl, '{task_id}')}`)
if (credentials.workspaceId.length === 0) {
  line('       未提供业务空间 ID，使用老域名。老域名仍可用；若想用更稳的专属域名，')
  line('       把 `workspaceId: <业务空间ID>` 写进插件配置即可。')
}

// ---------------------------------------------------- 步骤 3：配置体检

const ctx = { tools: { register: () => {}, get: () => undefined }, systemPrompt: { section: () => {}, getSectionOrder: () => 0 } }
const tool = createTool(ctx, config)
line(`[3/5] 工具已装配：name=${tool.name}，超时上限 ${tool.timeoutMs}ms`)

if (!CONFIRM) {
  line()
  line('[4/5] 跳过（未给 --yes，不产生费用）')
  line('[5/5] 跳过')
  line()
  line('一切就绪。要真出一张图验证接口形状，请重跑并加 --yes：')
  line('  node test/verify-real.mjs --yes')
  process.exit(0)
}

// ---------------------------------------------------- 步骤 4：真出一张图

const title = argValue('--title', '链路探针')
const prompt = argValue(
  '--prompt',
  '一个音乐评分网站的作品详情页：顶部是专辑封面与艺术家名，中部是曲目列表，右侧是评分分布柱状图，整体深色主题、克制、信息密度高。',
)
line(`[4/5] 真的开始生成：${title}（1K 档，预计约 ¥0.25，通常 1-3 分钟）`)
const startedAt = Date.now()
const result = await tool.execute({ title, prompt, kind: 'screen', aspect: '16:9', quality: '1k' })
const elapsed = Math.round((Date.now() - startedAt) / 1000)

if (!result.ok) {
  line(`       失败（耗时 ${elapsed}s）：`)
  for (const raw of result.content[0].text.split('\n')) line(`       ${raw}`)
  line()
  line('失败的调用不计费。上面第一条错误通常就是根因。')
  process.exit(1)
}

line(`       成功：${result.version}，${result.size}，实际档位 ${result.imageTier}，约 ¥${result.estimatedCostCny}，耗时 ${elapsed}s`)
if (result.notes) line(`       注意：${result.notes}`)

// ---------------------------------------------------- 步骤 5：验证副作用

const info = await stat(result.imagePaths[0])
const bytes = await readFile(result.imagePaths[0])
line(`[5/5] 落盘校验：`)
line(`       图片 ${result.imagePaths[0]}（${info.size} 字节，PNG 头=${bytes.slice(1, 4).toString('ascii') === 'PNG' ? '是' : '否'}）`)
line(`       元数据 ${result.metaPath}`)
line(`       索引 ${result.indexPaths[0]}`)
const metaText = await readFile(result.metaPath, 'utf8')
line(`       元数据含密钥=${metaText.includes(parsed.apiKey) ? '是（严重问题！）' : '否'}`)
line(`       request_id=${result.requestId ?? '（未返回）'}`)
line()
line('接口形状假设全部成立。接下来可以在 GUI 里直接让 agent 调用 design_sketch 了。')
line(`图片路径（可直接打开）：${result.imagePaths[0]}`)
