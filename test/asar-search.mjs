/**
 * 只读解析 Electron asar 并搜索字符串 —— 用来定位 DSH 内部的校验逻辑。
 * 纯 Node 标准库：asar 头是一个 pickle 编码的 JSON 目录树，随后是拼接的文件内容。
 */
import { open, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const ARCHIVE = process.argv[2]
const NEEDLE = process.argv[3]
const OUT = process.argv[4] ?? null

const handle = await open(ARCHIVE, 'r')
const sizeBuf = Buffer.alloc(8)
await handle.read(sizeBuf, 0, 8, 0)
const headerSize = sizeBuf.readUInt32LE(4)
// header 是 pickle：4 字节长度 + 4 字节 payload 长度 + payload
const headerBuf = Buffer.alloc(headerSize)
await handle.read(headerBuf, 0, headerSize, 8)
const jsonLength = headerBuf.readUInt32LE(4)
const jsonStart = 8
const header = JSON.parse(headerBuf.slice(jsonStart, jsonStart + jsonLength).toString('utf8'))
const baseOffset = 8 + headerSize

const files = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    if (entry.files !== undefined) walk(entry, path)
    else if (entry.size !== undefined) files.push({ path, offset: Number(entry.offset), size: entry.size })
  }
}
walk(header, '')

console.log(`归档内文件数=${files.length}  头大小=${headerSize}`)
const targets = files.filter((f) => /\.(js|mjs|cjs|ts|json)$/i.test(f.path))
console.log(`可搜文本文件=${targets.length}`)

let hits = 0
for (const file of targets) {
  if (file.size > 4 * 1024 * 1024) continue
  const buf = Buffer.alloc(file.size)
  await handle.read(buf, 0, file.size, baseOffset + file.offset)
  const text = buf.toString('utf8')
  if (!text.includes(NEEDLE)) continue
  hits++
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!line.includes(NEEDLE)) return
    console.log(`\n=== ${file.path}:${index + 1} ===`)
    console.log(line.trim().slice(0, 400))
  })
  if (OUT !== null && hits === 1) {
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, text, 'utf8')
    console.log(`\n[已把全文导出到 ${OUT}]`)
  }
}
console.log(`\n命中文件数=${hits}`)
await handle.close()
