/**
 * 在 asar 内精确搜索一个字符串，打印所有命中位置及其上下文行。
 */
import { open } from 'node:fs/promises'

const ARCHIVE = process.argv[2]
const NEEDLE = process.argv[3]
const CONTEXT = Number(process.argv[4] ?? 6)

const handle = await open(ARCHIVE, 'r')
const sizeBuf = Buffer.alloc(8)
await handle.read(sizeBuf, 0, 8, 0)
const headerSize = sizeBuf.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerSize)
await handle.read(headerBuf, 0, headerSize, 8)
const jsonLength = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.slice(8, 8 + jsonLength).toString('utf8'))
const baseOffset = 8 + headerSize

const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    if (entry.files !== undefined) walk(entry, path)
    else if (entry.size !== undefined) {
      const offset = Number(entry.offset)
      const size = Number(entry.size)
      if (Number.isInteger(offset) && Number.isInteger(size) && size >= 0) files.push({ path, offset, size })
    }
  }
}
walk(header, '')

let hits = 0
for (const file of files) {
  if (!/\.(js|mjs|cjs)$/i.test(file.path) || file.size > 6 * 1024 * 1024) continue
  const buf = Buffer.alloc(file.size)
  await handle.read(buf, 0, file.size, baseOffset + file.offset)
  const text = buf.toString('utf8')
  let index = text.indexOf(NEEDLE)
  if (index < 0) continue
  while (index >= 0) {
    hits++
    const before = text.slice(0, index).split('\n')
    const lines = text.slice(index).split('\n')
    const from = Math.max(0, before.length - CONTEXT)
    console.log(`\n########## ${file.path}  (第 ${before.length} 行) ##########`)
    for (let i = from; i < before.length + CONTEXT; i++) {
      const line = (i < before.length ? before[i] : lines[i - before.length]) ?? ''
      const mark = i === before.length - 1 ? '>>' : '  '
      console.log(`${mark} ${String(i + 1).padStart(5)}| ${line.slice(0, 220)}`)
    }
    index = text.indexOf(NEEDLE, index + 1)
    if (hits > 6) break
  }
  if (hits > 6) break
}
console.log(`\n命中=${hits}`)
await handle.close()
