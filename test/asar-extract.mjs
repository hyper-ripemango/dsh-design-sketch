/** 导出 asar 内某个文件的全文，便于直接读源码。 */
import { open, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const ARCHIVE = process.argv[2]
const WANTED = process.argv[3]
const OUT = process.argv[4]

const handle = await open(ARCHIVE, 'r')
const head = Buffer.alloc(8)
await handle.read(head, 0, 8, 0)
const headerSize = head.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerSize)
await handle.read(headerBuf, 0, headerSize, 8)
const jsonLength = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.slice(8, 8 + jsonLength).toString('utf8'))
const baseOffset = 8 + headerSize

let found = null
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    if (entry.files !== undefined) walk(entry, path)
    else if (path === WANTED && Number.isInteger(Number(entry.offset))) found = { path, offset: Number(entry.offset), size: Number(entry.size) }
  }
}
walk(header, '')

if (found === null) {
  console.log(`归档里没有：${WANTED}`)
  process.exit(1)
}
const buf = Buffer.alloc(found.size)
await handle.read(buf, 0, found.size, baseOffset + found.offset)
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, buf)
console.log(`已导出 ${found.path}（${found.size} 字节）→ ${OUT}`)
await handle.close()
