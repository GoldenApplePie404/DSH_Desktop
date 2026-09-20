'use strict'
/**
 * scripts/make-app-icon.cjs —— 正式应用图标管线
 *   输入：一张方形源图（默认 assets/candidates/maid-right-head-closeup.png）
 *   输出：assets/icon.png（256x256，窗口/托盘运行时用）
 *         assets/icon.ico（16/24/32/48/64/128/256 多尺寸，exe/安装包用）
 * 用法：node scripts/make-app-icon.cjs [源图路径]
 */
const sharp = require('C:/Users/czhdq/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')
const path = require('node:path')
const fs = require('node:fs')

const SRC = process.argv[2] || path.join(__dirname, '..', 'assets', 'candidates', 'maid-right-head-closeup.png')
const OUT_DIR = path.join(__dirname, '..', 'assets')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** 把多张 PNG 打包成 ICO（PNG 压缩条目，Vista+ 通用） */
function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + 16 * entries.length
  const dir = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // width（0=256）
    e.writeUInt8(size >= 256 ? 0 : size, 1) // height
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)  // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)])
}

;(async () => {
  if (!fs.existsSync(SRC)) throw new Error(`source not found: ${SRC}`)
  const png256 = await sharp(SRC).resize(256, 256, { fit: 'fill' }).png({ compressionLevel: 9 }).toBuffer()

  const icoEntries = []
  for (const size of SIZES) {
    const data = await sharp(SRC).resize(size, size, { fit: 'fill' }).png({ compressionLevel: 9 }).toBuffer()
    icoEntries.push({ size, data })
  }

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256)
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), packIco(icoEntries))
  console.log('wrote assets/icon.png  (256x256,', png256.length, 'bytes)')
  console.log('wrote assets/icon.ico (', icoEntries.map((e) => e.size).join('/'), ',', packIco(icoEntries).length, 'bytes)')
})().catch((e) => { console.error(e); process.exit(1) })
