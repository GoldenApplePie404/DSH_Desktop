'use strict'
/**
 * scripts/after-pack.cjs —— electron-builder afterPack 钩子
 * 在 app 目录打包完成后、NSIS/便携版封装前，用 rcedit 把自定义图标嵌入 exe。
 * （signAndEditExecutable: false 时 electron-builder 跳过 exe 资源编辑，
 *   这里手动补上，绕开 winCodeSign 符号链接权限问题。）
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

function findRcedit() {
  const root = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(root)) return null
  const found = []
  for (const dir of fs.readdirSync(root)) {
    const top = path.join(root, dir)
    if (!fs.statSync(top).isDirectory()) continue // 跳过 .7z 等文件
    // rcedit 在 hash 目录顶层（windows-10/ 里也可能有，一并找）
    for (const base of [top, path.join(top, 'windows-10')]) {
      if (!fs.existsSync(base)) continue
      for (const c of fs.readdirSync(base)) {
        if (/^rcedit.*\.exe$/i.test(c)) found.push(path.join(base, c))
      }
    }
  }
  return found.find((f) => /x64/i.test(f)) || found[0] || null
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** rcedit 可能在 app-builder 释放句柄前执行而瞬时失败，重试数次 */
function runRceditWithRetry(rcedit, args, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      execFileSync(rcedit, args, { stdio: 'inherit' })
      return true
    } catch (e) {
      if (i === tries) throw e
      const msg = String(e.message).split('\n')[0]
      console.warn(`[after-pack] rcedit attempt ${i} failed (${msg}), retrying in 1.5s…`)
      sleepSync(1500)
    }
  }
  return false
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const exe = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  const ico = path.join(packager.projectDir, 'assets', 'icon.ico')
  const rcedit = findRcedit()

  if (!rcedit) { console.warn('[after-pack] rcedit not found — skip icon embed'); return }
  if (!fs.existsSync(exe)) { console.warn(`[after-pack] exe not found: ${exe}`); return }
  if (!fs.existsSync(ico)) { console.warn(`[after-pack] ico not found: ${ico}`); return }

  console.log(`[after-pack] embedding icon into ${path.basename(exe)}`)
  runRceditWithRetry(rcedit, [exe, '--set-icon', ico])
}
