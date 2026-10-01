# DEVELOPMENT.md

给改这个插件的人。用户向的说明在 [README.md](README.md)。

---

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 工具定义（`defineTool`）、参数校验、草稿闸门、调用编排、结果交付、systemPrompt 规则 |
| `core.mjs` | 纯逻辑层：尺寸与计费、请求体组装、响应解析、HTTP 与轮询、落盘、PNG 编码 |
| `guard.mjs` | 交付前自检：按 DSH 的"无损 JSON"规则核对返回值 |
| `test/` | 冒烟、端到端、诊断、泄露审计、真实探针 |
| `tools/` | 发布打包、测试替身重建 |

`core.mjs` 刻意不 import 任何 DSH 包，所以能在 DSH 之外直接单测；
`index.mjs` 才依赖 `@deepseek-ai/dsh-tools` 与 `schemastery`。

---

## 两个入口：草稿闸门与生成

工具一次调用只有两种归宿：

```
execute(args)
├─ askOnly: true   → 草稿闸门：合成提示词 → 原样返回 → 结束（不请求 API、不计费）
└─ 否则             → 生成：解析参考图 → 建任务 → 轮询 → 下载落盘 → 写元数据
```

**草稿闸门放在密钥检查之前**：光看提示词不需要 key，没配 key 也能先审稿。

`promptOverride` 是"用户改过的那一版"的落地通道 —— 传了它就不再套模板，
原样使用。元数据里的 `promptSource` 会记成 `user-reviewed` 而不是 `template`，
这样事后能回答"这张图当时到底发了什么、是谁定的"。

---

## 改完为什么必须重启 DSH

DSH 里的插件是 **ESM 模块**，运行中的进程**不会**因为你改了磁盘上的文件就重新加载。
表现极具迷惑性：**一部分新代码生效、一部分没有**，于是你会对着一个"已经修好的 bug"
反复怀疑人生。

**最快的破案手段是"文件副作用探针"**（返回值传不出来时，只有写盘能证明代码跑到了）：

```js
// apply() 装载时、execute() 开始时各写一行
async function probe(stage, config, detail = '') {
  await appendFile(join(config.outputDir, 'delivery-audit.log'), `${isoLocal()} [${stage}] ${detail}\n`, 'utf8')
}
```

调用一次后日志**一个字都没有** → 铁证：新代码根本没执行，该重启 DSH 了。

同理，正文里埋着版本戳（`<!-- CODE-MARKER-2B -->`），返回正常时一眼能确认版本。

---

## 工具结果必须是"无损 JSON"

DSH 在 `execute()` 返回后会做一次快照校验
（`dsh-tools` 的 `snapshotToolValue` → `dsh-util-values` 的 `walkJsonValue`），
不通过就抛 `ToolOutputError`：

```
tool "xxx" returned invalid output: value is not lossless JSON
```

**这句话有歧义**：它不代表"模型返回了怪数据"，而是"你返回的对象里有 JSON 表达不了的东西"。
判定规则比"没有 undefined"严得多：

| 规则 | 踩坑点 |
| --- | --- |
| `undefined` → 拒 | **头号杀手**。`seed: seed === undefined ? undefined : seed` 这种写法必炸 |
| 数字必须有限且 ≠ `-0` | `Object.is(current, -0)` 会拒 |
| 数组自有键数必须恰好 `length + 1` | 往数组上挂属性就废 |
| 原型必须是纯 `Object.prototype` | 类实例 / Map / Set / Date 全拒 |
| 键必须全可枚举字符串 | symbol 键、不可枚举键拒 |
| 不允许循环引用 | 同一对象挂两处也会中招 |

**防御三层，缺一不可**（见 `stripUndefined` / `deliver` / `guard.mjs`）：

1. `stripUndefined()` —— 递归剥掉值为 `undefined` 的键（**`null` 要保留**，语义不同）
2. `deliver()` 里做一次 `JSON.parse(JSON.stringify(x))` 物化 —— 交给调用方的必然是全新纯对象
3. `auditLossless()` 自检 —— 交付前用 DSH 的原算法自查，违规则把**具体路径与原因**
   写进 `<outputDir>/delivery-audit.log`，而不是让整次调用静默失败

### `JSON.stringify` 会掩盖这个 bug

第一版 e2e 的"结果契约校验"用 `JSON.stringify` 做对比 —— 而它**恰好会静默丢掉
值为 `undefined` 的属性**，于是测试全绿、真机全红。现在校验器自己递归扫描，
并且**给校验器本身加了自检**：

```js
const badShape = { ok: true, seed: undefined, content: [...] }
check('自检：校验器能抓出 undefined 属性', validate(badShape).some(p => p.includes('undefined')))
```

**规矩：任何"帮我判断合不合格"的函数，都必须有一条用例证明它在坏输入上会失败。**

---

## 副作用先于回报

调用链是「执行 body → **写盘/计费** → 快照返回值 → 失败」。所以报错时会出现最坏的组合：

- 图其实**已经生成、已经落盘、已经计费**（看到报错就重试 = 重复花钱）
- 但 agent 拿不到返回值，看不到图路径，只能靠读磁盘手工拼
- 用户以为"什么都没发生"，于是重试 —— 连环扣费

对策：**关键产物先落盘再回报**；`vNN.failed.json` 留失败现场；
**排查先看目录，不要先重试**。

---

## 运行时副本要手动同步

`pnpm install` 用**硬链接**把源码放进 `%DSH_HOME%\profiles\<profile>\node_modules\`，
但一旦副本缺文件，pnpm 会因为锁文件状态显示 `Already up to date` **而拒绝重建**
（实测加 `--force` 也没用）。改完源码用这个稳妥办法同步：

```powershell
$src = '<插件目录>'
$dst = '<运行时副本>'
foreach ($f in 'index.mjs','core.mjs','guard.mjs','package.json','cordis.patch.yml') {
  [System.IO.File]::WriteAllText("$dst\$f", [System.IO.File]::ReadAllText("$src\$f"), (New-Object System.Text.UTF8Encoding($false)))
}
```

然后**重启 DSH**，再调用一次确认 `delivery-audit.log` 里出现 `[apply] marker=...`。
跳过这两步 = 在测一份没被加载的代码。

---

## 配置项（profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-design-sketch
      name: 'dsh-design-sketch'
      config:
        keyFile: '<密钥文件>'
        outputDir: '<工作区>\demo\design'   # 必填
        workspaceRoot: '<工作区>'
        region: 'cn-beijing'               # 必须与 key 的地域一致
        workspaceId: ''                    # 有则用专属域名
        model: 'qwen-image-3.0-pro'
        apiMode: 'async'                   # async | sync | openai | auto
        quality: '1k'
        n: 1
        promptExtend: true
        enableThinking: true
        watermark: false
        maxWaitMs: 300000
        pollIntervalMs: 3000
```

单张出图实测 **73–111 秒**（`enableThinking` 开着），同步请求会把一条连接占死，
所以主路是**建任务 + 轮询**：

```
POST {host}/api/v1/services/aigc/image-generation/generation   ← X-DashScope-Async: enable
GET  {host}/api/v1/tasks/{task_id}                              ← 每 3s 一次
```

`apiMode: 'auto'` 按 **异步 → 同步 → OpenAI 兼容** 依次降级，
但**只在协议层不适用时**（404/405）才换形状；鉴权、内容审核、欠费类错误一律直接返回。

---

## 密钥处理

优先级：`调用参数 apiKey` > `配置 apiKey` > `配置 keyFile` 文件 > `环境变量 DASHSCOPE_API_KEY`。

提取器对格式很宽容（剥 BOM、去引号、认得 `API Key:` 标签），但**字符类必须包含 `.`** ——
workspace 级 key 形如 `sk-ws-<段>.<段>.<段>.<段>`，漏了点号会在第一个点处断掉，
报"文件里没找到 key"，而文件其实是对的。这条有回归用例守着。

**密钥只出现在 HTTP 请求头里**，不写落盘文件、工具结果、错误信息或日志；
`test/e2e.mjs` 有一条"全量落盘文件扫描"专门守住它。

---

## 测试

```powershell
npm run test:stubs           # clone 之后先跑一次（重建测试替身目录）
npm test                     # smoke 147 项 + e2e 157 项，零网络、零花费
node test\diagnose-deep.mjs  # 无损 JSON / 重复引用 / JSON 往返差异 / 数字体检
node test\verify-real.mjs    # 真实链路探针（不花钱）
node test\verify-real.mjs --yes   # 真出一张图（约 ¥0.25）
node test\audit-leaks.mjs    # 泄露审计：密钥、令牌、Cookie、个人路径
```

| 文件 | 内容 |
| --- | --- |
| `test/smoke.mjs` | 纯函数、密钥提取、尺寸与计费、限流重试、轮询状态机 |
| `test/e2e.mjs` | 本地假 DashScope 驱动**真实的 `execute()`**，含草稿闸门、结果契约校验与泄露扫描 |
| `test/lossless.mjs` | 照搬 DSH 判定规则的校验器（比 `JSON.stringify` 严格） |
| `test/asar-*.mjs` | **只读**解析 `app.asar` 找 DSH 源码（排查"报错到底哪来的"） |

> e2e 里的请求体断言**按内容查找而非按索引** —— 用例增删时索引会漂，
> 早期版本就因此把断言指到了错误的请求上。

---

## 发布

```powershell
node tools\prepare-release.mjs                 # 生成清洗后的发布副本
node test\audit-leaks.mjs --dir <发布副本>      # 必须 0 命中
```

`prepare-release.mjs` 的分级替换是**刻意**的：

- 文档/配置（README、`cordis.patch.yml`）：全量替换，含工作区路径与用户名
- 测试与工具：**只替换个人目录**，绝不碰 `C:\...\demo\design` 这类夹具路径
  （否则会把测试期望值改掉，例如 `toPosix('C:\\x\\y')` 的期望从 `'C:/x/y'`
  变成占位符，用例直接失败）

本机私有替换表在 `.release-rules.json`（**不进包**）。早期版本把规则内联在
`prepare-release.mjs` 里，结果清洗器把自己的规则表也改了，不可重跑。

发布前硬性检查：

- `node test/audit-leaks.mjs` → **0 命中**（它会比对真实 key 的完整明文，只报文件与行号）
- 配置里的 `apiKey` / `keyFile` 等凭据字段**全部为空**
- 包内不出现任何真实密钥文件（`dashscope-key.txt`、`*-key.txt`、`.env*`）

---

MIT.
