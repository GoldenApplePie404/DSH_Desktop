'use strict'
// 探测 webp 立绘的尺寸与角色（非透明）包围盒，用于头像裁剪
const sharp = require('C:/Users/czhdq/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')

const files = [
  'E:/In_development/DeepSeek Harness_Projects/dsh-deep-whale-main/maid-atelier/assets/maid-atelier-maid-left-v5.webp',
  'E:/In_development/DeepSeek Harness_Projects/dsh-deep-whale-main/maid-atelier/assets/maid-atelier-maid-right-v6.webp',
]

;(async () => {
  for (const f of files) {
    const meta = await sharp(f).metadata()
    const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1
    let opaque = 0
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const a = data[(y * info.width + x) * 4 + 3]
        if (a > 8) {
          opaque++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    console.log(`${f.split('/').pop()}: ${info.width}x${info.height} alpha=premultiplied? channels=${info.channels}`)
    console.log(`  bbox: x[${minX}..${maxX}] y[${minY}..${maxY}]  (w=${maxX - minX + 1}, h=${maxY - minY + 1})  opaquePx=${opaque}`)
  }
})().catch((e) => { console.error(e); process.exit(1) })
