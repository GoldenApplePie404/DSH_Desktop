'use strict'

/**
 * scripts/make-icon.cjs —— 用纯 Node（zlib）生成 256x256 PNG 应用图标，
 * 零第三方依赖。运行：node scripts/make-icon.cjs
 * 产物：assets/icon.png（electron-builder 会从 256px PNG 自动生成 .ico）
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ---------- 最小 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function makePng(size, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // width
  ihdr.writeUInt32BE(size, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
      raw[o++] = a
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 绘制：DeepSeek 深蓝渐变圆角方块 + 中央白色圆点 ----------
const SIZE = 256
const png = makePng(SIZE, (x, y) => {
  const cx = (SIZE - 1) / 2
  const cy = (SIZE - 1) / 2
  const radius = SIZE * 0.22
  // 圆角矩形内外距离（近似）
  const rx = Math.abs(x - cx) - (cx - radius)
  const ry = Math.abs(y - cy) - (cy - radius)
  const dist = Math.hypot(Math.max(rx, 0), Math.max(ry, 0)) + Math.min(Math.max(rx, ry), 0)
  const inRounded = dist <= radius

  // 中央白色圆点（类似对话框气泡）
  if (Math.hypot(x - cx, y - cy) <= SIZE * 0.16) return [255, 255, 255, 255]

  const t = y / SIZE
  const r = Math.round(77 - 30 * t)
  const g = Math.round(107 + 30 * t)
  const b = Math.round(254 - 90 * t)
  return inRounded ? [r, g, b, 255] : [0, 0, 0, 0]
})

const out = path.join(__dirname, '..', 'assets', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
