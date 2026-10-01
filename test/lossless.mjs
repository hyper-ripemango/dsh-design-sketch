/**
 * 用 DSH 自己的"无损 JSON"规则校验工具结果，并在失败时指出具体路径。
 *
 * 规则抄自 asar 里的 `@deepseek-ai/dsh-api-session-controller/lib/client.js`
 * 的 `walkJsonValue`（`snapshotJsonValue` 用它）。比"没有 undefined"严得多：
 *   - number：必须有限，且**不能是 -0**
 *   - 数组：必须是纯 Array 原型，且自有键数量恰好 = length + 1（多一个属性就废）
 *   - 对象：必须是纯对象原型（Object.prototype 或 null）
 *   - 键：必须全是**可枚举的字符串**键（symbol / 不可枚举键直接废）
 *   - 不允许循环引用
 *   - 只允许 null / boolean / string / 有限 number / 纯数组 / 纯对象
 *
 * 用法（被 e2e 与真实调用诊断共用）：
 *   validateLossless(value) → { ok: true } | { ok: false, path, reason }
 */

/** 是否为纯数组原型（不接受子类与伪造原型）。 */
function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  return Array.isArray(prototype) && Object.getPrototypeOf(prototype) === Object.prototype
}

/** 是否为纯对象原型（Object.prototype 或 null）。 */
function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

export function validateLossless(root) {
  const ancestors = new Set()
  const stack = [{ kind: 'visit', value: root, path: 'root' }]
  while (stack.length > 0) {
    const task = stack.pop()
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    const current = task.value
    const path = task.path
    if (current === null) continue
    if (typeof current === 'boolean' || typeof current === 'string') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { ok: false, path, reason: `非有限数字 ${current}` }
      if (Object.is(current, -0)) return { ok: false, path, reason: '-0 不是无损 JSON（会被序列化成 0，信息丢失）' }
      continue
    }
    if (typeof current === 'undefined') return { ok: false, path, reason: '值为 undefined' }
    if (typeof current !== 'object') return { ok: false, path, reason: `不可序列化类型 ${typeof current}` }
    if (ancestors.has(current)) return { ok: false, path, reason: '循环引用' }
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return { ok: false, path, reason: '数组原型不纯' }
      const keys = Reflect.ownKeys(current)
      if (keys.length !== current.length + 1) {
        return { ok: false, path, reason: `数组自有键 ${keys.length} 个，但 length=${current.length}（多出的属性不是无损 JSON）` }
      }
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]
        if (key === 'length') continue
        if (typeof key !== 'string') return { ok: false, path, reason: `数组带 symbol 键 ${String(key)}` }
        stack.push({ kind: 'visit', value: current[key], path: `${path}[${key}]` })
      }
      continue
    }
    if (!hasPlainObjectPrototype(current)) {
      return { ok: false, path, reason: `对象原型不纯：${Object.getPrototypeOf(current)?.constructor?.name ?? 'null'}（会被 JSON 丢弃信息）` }
    }
    const keys = Reflect.ownKeys(current)
    for (const key of keys) {
      if (typeof key !== 'string') return { ok: false, path, reason: `对象带 symbol 键 ${String(key)}` }
      if (!Object.prototype.propertyIsEnumerable.call(current, key)) {
        return { ok: false, path: `${path}.${key}`, reason: '键不可枚举（JSON 会丢弃它）' }
      }
    }
    ancestors.add(current)
    stack.push({ kind: 'leave', source: current })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      stack.push({ kind: 'visit', value: current[key], path: `${path}.${key}` })
    }
  }
  return { ok: true }
}
