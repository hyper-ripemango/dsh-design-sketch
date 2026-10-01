# dsh-design-sketch

> **发布版说明**：本仓库是 `dsh-design-sketch` 的打包发布副本。
> **API Key 未填写**（配置项 `apiKey` / `keyFile` 都为空），使用前请自行在
> 阿里云百炼申请 key 并填入密钥文件——见下文「密钥」一节。
> 包内出现的 `<插件目录>`、`<DSH_HOME>`、`<工作区>`、`<密钥文件>`、`<用户目录>`、
> `<你的 GitHub 用户名>` 等**都是占位符**，请按自己机器的实际路径替换。

DSH host 插件：注册模型工具 **`design_sketch`** —— 让 agent 在需要前端 UI 设计时，
调用 **Qwen-Image 3.0 Pro** 生成设计效果图并**下载落盘到工作目录**，供你预览；
你提完修改意见后，agent 可以以上一版为参考图走**图生图（I2I）局部改**，而不是重新抽卡。

整页布局、单个组件（含按钮）、图标、多屏流程、插画素材都走同一个工具，靠 `kind` 切换模板。

纯 Node 实现（≥ 20.9）：无原生模块、无 shell 调用、不依赖任何 SDK。

---

## 它解决的是什么问题

写前端之前，"这个页面长什么样"往往只在脑子里。文字描述给模型→模型直接写代码→
你看到成品才发现方向不对，返工成本很高。

这个插件把**第一步变成一张可以看的图**：

```
你的需求 → design_sketch（T2I）→ v01.png 落盘 → 你打开看 → 提意见
                                                      ↓
                              design_sketch（reviseOf=v01，I2I 局部改）→ v02.png
                                                      ↓
                                          方向确认后才开始写前端代码
```

三个关键设计：

1. **图必须落盘**：模型返回的是 24 小时有效的临时 URL，不下载就没了。所以工具自己下载、
   校验 PNG、按 `v01`/`v02` 编号存好，并写一份元数据记录提示词、seed、request_id、费用。
2. **迭代有账本**：每个版本的 `vNN.json` 记录完整提示词、参考图来源、`basedOn`。
   到第三轮还能查清第一轮改了什么、为什么这张不能用。
3. **候选画幅按计费档卡死**：1K 档的尺寸绝不会跨过 225 万像素的 2K 阈值（否则费用翻倍），
   2K 档则保证跨过去（否则花了钱买不到画质）。

---

## ⚠️ 写给下一个改这个插件的人：五条踩过的坑

这一节是本插件最难排查的五件事的浓缩版。**它们都不是"注意点"，是真出过事故、真多花了钱的。**
如果你要给 DSH 写别的 host 插件，这一节基本可以直接照搬。

### 1. 工具结果必须是"无损 JSON"——而 `undefined` 会让整次调用静默失败

DSH 在工具 `execute()` 返回后，会先做一次快照校验
（`@deepseek-ai/dsh-tools` 的 `snapshotToolValue` → `@deepseek-ai/dsh-util-values` 的 `walkJsonValue`）。
只要值"不是无损 JSON"，它就抛 `ToolOutputError`：

```
tool "xxx" returned invalid output: value is not lossless JSON
```

**注意这句话的歧义**：它不代表"模型返回了怪数据"，而是"你返回的对象里有 JSON 表达不了的东西"。
判定规则比"没有 undefined"严得多：

| 规则 | 踩坑点 |
| --- | --- |
| `undefined` → 拒 | **头号杀手**。`seed: seed === undefined ? undefined : seed` 这种写法必炸 |
| 数字必须有限且 ≠ `-0` | `Object.is(current, -0)` 会拒 |
| 数组自有键数必须恰好 `length + 1` | 往数组上挂属性就废 |
| 原型必须是纯 `Object.prototype` | 类实例 / Map / Set / Date 全拒 |
| 键必须全可枚举字符串 | symbol 键、不可枚举键拒 |
| 不允许循环引用 | 同一对象挂两处也会中招 |

**防御三层，缺一不可**（都在源码里，看 `stripUndefined` / `deliver` / `guard.mjs`）：

1. `stripUndefined()` —— 递归剥掉值为 `undefined` 的键（**`null` 要保留**，语义不同）
2. `deliver()` 里做一次 `JSON.parse(JSON.stringify(x))` 物化 —— 交给调用方的必然是全新纯对象
3. `auditLossless()` 自检 —— 交付前用 DSH 的原算法自查，违规则把**具体路径与原因**写进
   `<outputDir>/delivery-audit.log`，而不是让整次调用静默失败

### 2. `JSON.stringify` 会掩盖这个 bug —— 测试写得比真机宽松，等于没测

第一次写 e2e 的"结果契约校验"时，我用 `JSON.stringify` 做对比 —— 而它**恰好会静默丢掉
值为 `undefined` 的属性**，于是测试全绿、真机全红。修法是让校验器自己递归扫描：

```js
scanLossless(value, path)   // 发现 undefined / 非有限数 / 函数 / symbol → 记问题
```

并且**给校验器本身加自检**，证明它真的抓得住：

```js
const badShape = { ok: true, seed: undefined, content: [...] }
check('自检：校验器能抓出 undefined 属性', validate(badShape).some(p => p.includes('undefined')))
```

**规矩：任何"帮我判断合不合格"的函数，都必须有一条用例证明它在坏输入上会失败。**

### 3. 副作用先于回传：报错 ≠ 白干，但重试 ≠ 幂等

调用链是「执行 body → **写盘/计费** → 快照返回值 → 失败」。

所以报错时会出现最坏的组合：

- **图其实已经生成、已经落盘、已经计费**（看到报错就重试 = 重复花钱）
- 但 agent **拿不到返回值**，看不到图路径，只能靠读磁盘手工拼
- 用户以为"什么都没发生"，于是重试 —— 连环扣费

对策：**把关键产物先落盘再回报**（本插件就是这么做的），并且出问题时先去看目录，
不要先重试。另外 `vNN.failed.json` 会留下失败现场，便于复盘。

### 4. 改完源码不生效？先确认"跑的是哪份代码"，别急着改代码

DSH 里的插件是 **ESM 模块**，运行中的进程**不会**因为你改了磁盘上的文件就重新加载。
表现极具迷惑性：**一部分新代码生效、一部分没有**（因为不同文件的加载时机不同），
于是你会对着一个"已经修好的 bug"反复怀疑人生。

**最快的破案手段是"文件副作用探针"**（返回值传不出来时，只有写盘能证明代码跑到了）：

```js
// apply() 装载时、execute() 开始时各写一行
async function probe(stage, config, detail = '') {
  await appendFile(join(config.outputDir, 'delivery-audit.log'), `${isoLocal()} [${stage}] ${detail}\n`, 'utf8')
}
```

调用一次后日志**一个字都没有** → 铁证：新代码根本没执行，该重启 DSH 了。

同理，正式正文里埋一个版本戳（本插件是 `<!-- CODE-MARKER-2B -->`），
返回正常时一眼就能确认版本。

### 5. 运行时副本要手动同步，`pnpm install` 靠不住

`pnpm install` 对本插件用**硬链接**把源码放进
`%DSH_HOME%\profiles\desktop\node_modules\dsh-design-sketch\`。
但一旦副本缺文件，pnpm 会因为锁文件状态显示 **`Already up to date` 而拒绝重建**
（实测加 `--force` 也没用）。所以改完源码用这个稳妥办法同步：

```powershell
$src = '<插件目录>'
$dst = '<运行时副本>'
foreach ($f in 'index.mjs','core.mjs','guard.mjs','package.json','cordis.patch.yml') {
  [System.IO.File]::WriteAllText("$dst\$f", [System.IO.File]::ReadAllText("$src\$f"), (New-Object System.Text.UTF8Encoding($false)))
}
```

然后**重启 DSH**（见第 4 条），再调用一次工具确认 `delivery-audit.log` 里出现
`[apply] marker=...`。别跳这两步 —— 跳过就等于在测一份没被加载的代码。

---

## 安装（本机已装好）

| 位置 | 文件 | 作用 |
| --- | --- | --- |
| `%DSH_HOME%\local-plugins\dsh-design-sketch\` | `index.mjs`、`core.mjs`、`guard.mjs`、`package.json`、`cordis.patch.yml` | **源码在此，改这里** |
| `%DSH_HOME%\profiles\desktop\node_modules\dsh-design-sketch\` | 同上（硬链接） | 运行时加载的副本，改完需手动同步（见上） |
| `%DSH_HOME%\profiles\desktop\package.json` | `dependencies` + `dsh.profile.bundles` | 声明依赖与 bundle |
| `%DSH_HOME%\profiles\desktop\cordis.patch.yml` | `id: dsh-design-sketch` 那条 `insert` | profile 层配置（live 监视，但**模块缓存仍需重启**） |

停用：把 `cordis.patch.yml` 里 `id: dsh-design-sketch` 那条 `insert` 删掉。

---

## 密钥

工具按这个优先级找 API Key：

```
调用参数 apiKey  >  配置 apiKey  >  配置 keyFile 指向的文件  >  环境变量 DASHSCOPE_API_KEY
```

推荐用文件（本机已按此配置）：

```powershell
Set-Content -Path '<密钥文件>' -Value 'sk-你的key' -Encoding ascii -NoNewline
```

文件里**只放一行 key**。带 BOM 会被自动剥掉，`API Key:` 之类标签也能被提取。

> **点号陷阱**：workspace 级 key 形如 `sk-ws-<段>.<段>.<段>.<段>`，**含 `.`**。
> 提取用的字符类必须包含点号，否则贪婪匹配会在第一个点就断，报"文件里没找到 key"
> —— 明明文件写对了。这条有回归用例守着（`test/smoke.mjs`）。

**密钥只出现在 HTTP 请求头里**：不写进落盘文件、工具结果、错误信息或日志。
`test/e2e.mjs` 里有一条"全量落盘文件扫描"（含 `delivery-audit.log`），专门守住这条。

---

## 工具参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string（必填） | 设计对象名，用作目录名与图内信息条，如「专辑详情页」 |
| `prompt` | string（必填） | 需求描述；不用写画幅与规格（模板自动补） |
| `kind` | string | `screen`（默认）/ `component` / `icon` / `flow` / `asset` / `free` |
| `aspect` | string | `16:9`（screen 默认）、`1:1`（component 默认）、`9:16`、`21:9`（flow 默认）、`3:2`…`auto` |
| `style` | string | 一句话风格，如「暗色、玻璃拟态、圆角 12px」 |
| `constraints` | string[] | 硬约束，如 `["主色 #3B82F6","不要侧栏"]` |
| `negative` | string | 必须避免的内容；不填按 `kind` 用内置反向提示词 |
| `reference` | string[] | 参考图：本地路径或公网 URL，最多 3 张（传了就是 I2I）。本地图自动转 base64 |
| `reviseOf` | string | `"v01"` / `"2"` 或图片路径：以上一版为基础局部改 |
| `size` | string | 显式尺寸 `宽*高`；留空按 `aspect` + `quality` 自动算 |
| `quality` | string | `1k`（约 ¥0.25/张）或 `2k`（约 ¥0.5/张） |
| `n` | integer | 出图张数 1–6，默认 1（每张都计费） |
| `seed` | integer | 固定种子，便于保风格微调 |
| `model` | string | 默认取配置；`qwen-image-3.0-pro` / `qwen-image-3.0` / `qwen-image-2.0-pro` … |
| `banner` | boolean | 在图上方加一条英文信息条（模型/画幅/尺寸/版本/时间） |
| `designDir` | string | 显式目录名；留空用 `<title>_<日期>` |

**`kind` 都是干什么的**：`screen` 出整页高保真界面；`component` 出单体组件并**强制画出
默认/悬停/按下/聚焦/禁用/加载全部状态**（做按钮就选它）；`icon` 出一套同视觉语言的图标；
`flow` 出多屏流程；`asset` 出插画素材；`free` 不套模板。

---

## 配置（profile 的 `cordis.patch.yml`，行 id `dsh-design-sketch`）

```yaml
- insert:
    - id: dsh-design-sketch
      name: 'dsh-design-sketch'
      config:
        keyFile: '<密钥文件>'
        outputDir: '<工作区>\demo\design'   # 必填；不配会明确报错而不是猜位置
        workspaceRoot: '<工作区>'           # 用来算 Markdown 相对路径
        region: 'cn-beijing'               # 必须与 key 的地域一致
        workspaceId: ''                    # 有则用专属域名 https://{id}.cn-beijing.maas.aliyuncs.com
        baseUrl: ''                        # 显式覆盖域名（一般不用）
        model: 'qwen-image-3.0-pro'
        apiMode: 'async'                   # async | sync | openai | auto
        quality: '1k'
        n: 1
        promptExtend: true
        enableThinking: true
        watermark: false
        banner: false
        timeoutMs: 60000                   # 单次 HTTP 超时
        retries: 2                         # 5xx/429 指数退避重试次数
        maxWaitMs: 300000                  # 轮询总上限
        pollIntervalMs: 3000
```

### 为什么默认走异步

单张出图实测 **73–111 秒**（`enableThinking` 开着），同步请求会把一条连接占死。
所以主路是**建任务 + 轮询**：

```
POST {host}/api/v1/services/aigc/image-generation/generation   ← X-DashScope-Async: enable
GET  {host}/api/v1/tasks/{task_id}                              ← 每 3s 一次
```

`apiMode: 'auto'` 会按 **异步 → 同步 → OpenAI 兼容** 依次降级，但**只在协议层不适用时**
（404/405）才换形状；鉴权、内容审核、欠费类错误一律直接返回 —— 那些错误换形状也救不回来。

---

## 落盘产物

```
<工作区>\demo\design\
├── delivery-audit.log            # 探针与自检日志（见"五条坑"第 1、4 条）
└── <设计名>_<日期>\
    ├── v01.png                   # 第一版效果图
    ├── v01.json                  # 元数据：完整提示词、seed、request_id、尺寸、耗时、费用、实际计费档
    ├── v02.png                   # 按你的意见改的第二版
    ├── v02.json                  # 其中 request.basedOn = "v01"，记录它基于哪一版改的
    ├── v03.failed.json           # 失败现场（若某次失败），含错误码与原始提示词，便于复盘
    └── README.md                 # 目录索引：版本表格 + 最新一版的需求与完整提示词
```

元数据示例（节选）：

```json
{
  "schema": "dsh-design-sketch/version@1",
  "version": "v02",
  "kind": "screen",
  "userPrompt": "保持整体布局不变，只把曲目列表行高加大",
  "prompt": "为网页产品生成一张高保真的前端界面视觉稿……",
  "request": { "aspect": "16:9", "size": "1520*848", "seed": 42, "basedOn": "v01" },
  "result": { "width": 1520, "height": 848, "elapsedSec": 47, "costCny": 0.25, "tier": "1k" }
}
```

---

## 计费与限流

| 项 | 值（华北2 北京） |
| --- | --- |
| 出图 1K | ¥0.25 / 张 |
| 出图 2K | ¥0.5 / 张 |
| 输入参考图 | ¥0.02 / 张 |
| 限流 | **RPM 5**（每分钟 5 次） |

- 按**成功出图张数**计费，失败的调用不计费。
- 撞限流会自动指数退避重试，不会白花钱。
- 工具的返回正文里带报价，agent 不需要猜。
- 极端长条画幅（`2:1`、`3:1`、`21:9`）受"单边 ≤2048"限制，**物理上跨不过 2K 计费线**，
  所以选了 `2k` 也只按 1K 出图 —— 这种情况工具会明确告诉你，不假装买到了 2K。

---

## 测试

```powershell
npm run test:stubs            # clone 之后先跑一次：重建测试替身目录
npm test                      # = smoke.mjs + e2e.mjs（零网络、零花费）
node test\diagnose-deep.mjs   # 深度诊断：无损 JSON / 重复引用 / JSON 往返差异 / 数字体检
node test\verify-real.mjs     # 真实链路探针（不花钱，只检查 key/域名/装配）
node test\verify-real.mjs --yes   # 真出一张图（约 ¥0.25）
```

| 文件 | 内容 |
| --- | --- |
| `test/smoke.mjs` | 147 项：纯函数、密钥提取、尺寸与计费、限流重试、轮询状态机 |
| `test/e2e.mjs` | 133 项：本地假 DashScope 服务驱动**真实的 `execute()`**，含结果契约校验与泄露扫描 |
| `test/lossless.mjs` | 照搬 DSH「无损 JSON」判定规则的校验器（比 `JSON.stringify` 严格） |
| `test/diagnose-*.mjs` | 出问题时的诊断脚本（无损 JSON / 运行时副本 / 深度体检） |
| `test/verify-real.mjs` | 真实 API 探针 |
| `test/asar-*.mjs` | **只读**解析 `app.asar` 找 DSH 源码（排查"报错到底哪来的"，纯标准库） |
| `test/audit-leaks.mjs` | **泄露审计**：扫密钥、令牌、Cookie、个人路径、邮箱 |
| `test/node_modules/@deepseek-ai/` | 两个测试替身（`dsh-tools`、`schemastery`），让 `createTool()` 能在 DSH 之外调用 |

> `node_modules/` 被 `.gitignore` 排除，所以 clone 之后**必须先跑 `npm run test:stubs`**
> 把替身接回插件根（建 junction，无需管理员），否则 `npm test` 会报模块找不到。

---

## 发布与打包

改完插件要发版时，用仓库自带的两个工具，**不要让密钥或个人路径混进包里**：

```powershell
node tools\prepare-release.mjs        # 生成清洗后的发布副本
node test\audit-leaks.mjs --dir <发布副本>   # 复核：必须 0 命中
```

`tools/prepare-release.mjs` 做四件事：

1. **复制到独立目录**（不动工作副本），跳过 `node_modules`、`.git`、本地日志
2. 把本机路径（`<插件目录>`/`<DSH_HOME>`/`<工作区>`/`<密钥文件>`）与 GitHub 用户名换成**占位符**
3. 生成包内 `.gitignore`（忽略 `node_modules/`、`*-key.txt`、`.env*`、`*.log`）
4. 在 `package.json` 里补齐 `test` / `test:stubs` / `audit:leaks` 脚本与仓库元数据

**发版前的硬性检查**（缺一不可）：

- `node test/audit-leaks.mjs` → **0 命中**（它会比对真实 key 的完整明文，只报文件与行号，不回显值）
- 配置文件里的 `apiKey` / `keyFile` / `cookie` 等凭据字段**全部为空**
- 包内不出现任何真实密钥文件（`dashscope-key.txt`、`*-key.txt`、`.env*`）

---

## 合规

- 出图由阿里云百炼（Model Studio）提供，遵守其服务条款。
- 生成的设计图**仅供设计参考**，不用作最终交付物；上线前请自行确认素材与字体的授权。
- API Key 属于凭据：不要提交到任何仓库，不要贴进聊天，失效后覆盖密钥文件即可。

MIT.
