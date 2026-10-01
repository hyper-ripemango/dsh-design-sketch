/**
 * 交付前自检：用 DSH 判定工具结果的那套算法（`@deepseek-ai/dsh-util-values`
 * 的 `walkJsonValue`，被 `dsh-tools` 的 `snapshotToolValue` 调用）自查一遍。
 *
 * 为什么要在插件里再实现一遍：真机上工具报
 * `tool "design_sketch" returned invalid output: value is not lossless JSON`，
 * 而离线复现（同进程 import 后调用 execute）永远通过 —— 说明差异来自运行环境而非
 * 数据形状。把判定搬到插件进程内，就能在**真实调用路径上**抓出到底哪个路径违规，
 * 而不是继续猜。
 *
 * 规则逐条对齐 `dsh-util-values`：
 *   - null / boolean / string 直接通过
 *   - number 必须有限且不是 -0
 *   - 其它类型必须是 object，且不能处于"祖先链"上（即不允许循环/重复引用）
 *   - 数组：原型必须是某 realm 的正经 Array.prototype，且自有键数 === length + 1
 *   - 对象：原型必须是 null 或某 realm 的正经 Object.prototype；键必须全是可枚举字符串
 */

/** 判定原型是否为"某个 realm 的纯 Array.prototype"。 */
function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype)) return false
  if (!hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object' && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype)
}

/** 判定原型是否为"某个 realm 的纯 Object.prototype"或 null 原型。 */
function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || (typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype))
}

/** 原型是否带有"正经的"同名内建构造器（跨 realm 容忍）。 */
function hasIntrinsicConstructor(prototype, name) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
  if (typeof constructor !== 'function') return false
  try {
    return (
      constructor.name === name &&
      constructor.prototype === prototype &&
      Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === 'Array' ? Array : Object)
    )
  } catch {
    return false
  }
}

/** 是否为本 realm 的 Object.prototype。 */
function isIntrinsicObjectPrototype(value) {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** 只保留可枚举字符串键；否则返回 undefined。 */
function enumerableStringKeys(value) {
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined
  return keys
}

/**
 * 用 DSH 的规则检查一个值，失败时给出**具体路径与原因**。
 *
 * @returns {{ ok: true } | { ok: false, path: string, reason: string }}
 */
export function auditLossless(root) {
  const ancestors = new Set()
  const tasks = [{ kind: 'visit', value: root, path: 'root' }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return { ok: false, path: task.path, reason: '数组有空洞（index 不是自有属性）' }
      tasks.push({ kind: 'visit', value: task.source[task.index], path: `${task.path}[${task.index}]` })
      continue
    }
    const current = task.value
    const path = task.path
    if (current === null) continue
    if (typeof current === 'boolean' || typeof current === 'string') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { ok: false, path, reason: `非有限数字 ${current}` }
      if (Object.is(current, -0)) return { ok: false, path, reason: '-0' }
      continue
    }
    if (typeof current !== 'object') return { ok: false, path, reason: `类型 ${typeof current} 不是 JSON 值` }
    if (ancestors.has(current)) return { ok: false, path, reason: '循环引用或同一对象被挂到多处' }
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return { ok: false, path, reason: '数组原型不是纯 Array.prototype' }
      const length = current.length
      if (Reflect.ownKeys(current).length !== length + 1) {
        return { ok: false, path, reason: `数组自有键 ${Reflect.ownKeys(current).length} 个 ≠ length+1（${length + 1}）` }
      }
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = length - 1; index >= 0; index--) tasks.push({ kind: 'array-item', source: current, index, path })
      continue
    }
    if (!hasPlainObjectPrototype(current)) {
      const name = Object.getPrototypeOf(current)?.constructor?.name ?? 'null'
      return { ok: false, path, reason: `对象原型不是纯 Object.prototype（看起来像 ${name} 的实例）` }
    }
    const keys = enumerableStringKeys(current)
    if (keys === undefined) return { ok: false, path, reason: '存在 symbol 键或不可枚举键' }
    ancestors.add(current)
    tasks.push({ kind: 'leave', source: current })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      tasks.push({ kind: 'visit', value: current[key], path: `${path}.${key}` })
    }
  }
  return { ok: true }
}

/** 把审计结果写成一个简短的、自身无损的字符串（写盘用）。 */
export function describeAudit(label, value) {
  const verdict = auditLossless(value)
  if (verdict.ok) return `${label}: OK`
  return `${label}: FAIL @ ${verdict.path} — ${verdict.reason}`
}
