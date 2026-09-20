'use strict'
// 从女仆鲸鱼娘立绘生成头像候选（透明背景 256x256 PNG）
// 用法：node scripts/make-icon-variants.cjs
const sharp = require('C:/Users/czhdq/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', 'assets', 'candidates')
fs.mkdirSync(OUT, { recursive: true })

const SOURCES = [
  { name: 'maid-left', file: 'E:/In_development/DeepSeek Harness_Projects/dsh-deep-whale-main/maid-atelier/assets/maid-atelier-maid-left-v5.webp' },
  { name: 'maid-right', file: 'E:/In_development/DeepSeek Harness_Projects/dsh-deep-whale-main/maid-atelier/assets/maid-atelier-maid-right-v6.webp' },
]

// 裁剪变体：sideFrac = 方形边长占 bbox 高的比例；centerFrac = 中心在 bbox 纵坐标的比例
const VARIANTS = [
  { label: 'head-closeup', sideFrac: 0.30, centerFrac: 0.16 },
  { label: 'head-shoulder', sideFrac: 0.42, centerFrac: 0.22 },
  { label: 'head-torso', sideFrac: 0.55, centerFrac: 0.30 },
]

async function bboxOf(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

;(async () => {
  for (const src of SOURCES) {
    const bbox = await bboxOf(src.file)
    const cx = bbox.x + bbox.w / 2
    for (const v of VARIANTS) {
      const side = Math.round(bbox.h * v.sideFrac)
      const cy = bbox.y + bbox.h * v.centerFrac
      let left = Math.round(cx - side / 2)
      let top = Math.round(cy - side / 2)
      // 越界钳制
      left = Math.max(0, Math.min(left, 2000 - side))
      top = Math.max(0, Math.min(top, 3000 - side))
      const outFile = path.join(OUT, `${src.name}-${v.label}.png`)
      await sharp(src.file)
        .extract({ left, top, width: side, height: side })
        .resize(256, 256, { fit: 'fill' })
        .png({ compressionLevel: 9 })
        .toFile(outFile)
      console.log(`wrote ${path.relative(process.cwd(), outFile)}  (crop ${side}x${side} @ ${left},${top})`)
    }
  }
})().catch((e) => { console.error(e); process.exit(1) })
