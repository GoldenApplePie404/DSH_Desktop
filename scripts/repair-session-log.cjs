'use strict'

/**
 * scripts/repair-session-log.cjs —— DSH 会话日志（JSONL / JSONL.zstd）完整性检查与修复
 *
 * 背景：两个 dsh web 实例同时打开同一个会话时（例如网页版 + 桌面版并存），
 * 双方各自持有独立的 seq 计数器并向同一个 session.jsonl[.zstd] 追加行，
 * 导致日志里出现 seq 回跳/重叠的"分叉流"。DSH 的读取器遇到
 * "seq gap in committed region"（若分叉区内含 turn/end 则直接抛错）后，
 * 整个会话历史无法加载（历史加载失败：history unavailable for session ...）。
 *
 * 本工具把日志按 seq 连续性合并成一条可加载的流：
 *   - 完全重叠的行（seq 范围已存在）→ 丢弃
 *   - 部分重叠的打包行（seq0 范围跨过当前计数）→ 把 seq0 重编号到当前计数
 *   - 前向空洞（seq 大于当前计数）→ 无法合并，从此处截断并报告
 * 未改动的行保持字节不变；修复前自动备份原文件。
 *
 * 用法：
 *   node scripts/repair-session-log.cjs            # 检查 $DSH_HOME/sessions 下全部日志
 *   node scripts/repair-session-log.cjs --fix      # 检查并修复（损坏的才写回）
 *   node scripts/repair-session-log.cjs --file <路径> [--fix]   # 只处理指定日志
 *   node scripts/repair-session-log.cjs --dsh-home <目录>       # 覆盖 $DSH_HOME
 *
 * 依赖：需要 Node ≥ 23.2（node:zlib 内置 Zstandard）。旧版 Node 会尝试
 * 使用 PATH 中的 `zstd` CLI（--zstd <path> 可指定）。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const wantFix = args.includes('--fix')
const wantFile = argValue('--file')
const dshHome = argValue('--dsh-home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const zstdCli = argValue('--zstd')

function argValue(name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

// ---------------------------------------------------------------------------
// Zstandard：node:zlib（Node ≥ 23.2）优先，其次 zstd CLI
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 4247762216 // 0xFD2FB528

let zstdImpl = null
try {
  const zlib = require('node:zlib')
  if (typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function') {
    zstdImpl = {
      kind: 'node:zlib',
      decompress(buf) { return zlib.zstdDecompressSync(buf) },
      compress(buf) { return zlib.zstdCompressSync(buf) },
    }
  }
} catch { /* 旧版 Node */ }

function findZstdCli() {
  const candidates = zstdCli ? [zstdCli] : []
  if (!zstdCli) {
    for (const name of ['zstd', 'zstd.exe']) {
      try {
        const p = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .split(/\r?\n/)[0]
        if (p && fs.existsSync(p.trim())) candidates.push(p.trim())
      } catch { /* not on PATH */ }
    }
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch { /* invalid */ }
  }
  return null
}

function ensureZstd() {
  if (zstdImpl) return zstdImpl
  const cli = findZstdCli()
  if (!cli) {
    throw new Error(
      '未找到 Zstandard 支持：需要 Node ≥ 23.2（node:zlib 内置），或 PATH 中有 zstd CLI（--zstd <path> 指定）'
    )
  }
  return {
    kind: 'cli:' + cli,
    decompress(buf) {
      const tmpIn = path.join(os.tmpdir(), `dsh-repair-in-${process.pid}.bin`)
      const tmpOut = path.join(os.tmpdir(), `dsh-repair-out-${process.pid}.bin`)
      try {
        fs.writeFileSync(tmpIn, buf)
        execFileSync(cli, ['-d', '-f', tmpIn, '-o', tmpOut], { stdio: 'ignore' })
        return fs.readFileSync(tmpOut)
      } finally {
        for (const t of [tmpIn, tmpOut]) { try { fs.unlinkSync(t) } catch { /* ignore */ } }
      }
    },
    compress(buf) {
      const tmpIn = path.join(os.tmpdir(), `dsh-repair-in-${process.pid}.bin`)
      const tmpOut = path.join(os.tmpdir(), `dsh-repair-out-${process.pid}.bin`)
      try {
        fs.writeFileSync(tmpIn, buf)
        execFileSync(cli, ['-q', '-f', tmpIn, '-o', tmpOut], { stdio: 'ignore' })
        return fs.readFileSync(tmpOut)
      } finally {
        for (const t of [tmpIn, tmpOut]) { try { fs.unlinkSync(t) } catch { /* ignore */ } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// zstd 帧扫描（与 dsh-session-persistence-jsonl 的 scanZstdFrames 同款）
// 返回 { frames: [{start,end}], tornStart?: number }
// ---------------------------------------------------------------------------
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

// ---------------------------------------------------------------------------
// 行解码：普通行单事件 [seq,seq]；打包行（text/reasoning/tool-call-chunks）
// 展开为 [seq0, seq0+成员数-1]
// ---------------------------------------------------------------------------
function seqRange(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const tag = value.type
  if (tag === 'text-chunks' || tag === 'reasoning-chunks' || tag === 'tool-call-chunks') {
    const data = value.data
    if (!data || typeof data !== 'object') return null
    const members = tag === 'tool-call-chunks' ? data.args : data.texts
    if (!Array.isArray(members) || members.length === 0) return null
    if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0) return null
    return [value.seq0, value.seq0 + members.length - 1]
  }
  if (!Number.isSafeInteger(value.seq)) return null
  return [value.seq, value.seq]
}

// ---------------------------------------------------------------------------
// 核心：把日志文本（首行为 header）合并成一条 seq 连续的流
// 返回 { ok, events, kept, skipped, renumbered, truncated, divergence, detail }
// ---------------------------------------------------------------------------
function mergeLog(plaintext) {
  // 按行切分；保留末尾换行；最后一段无换行视为 torn tail（与读取器一致，丢弃）
  const lines = []
  let start = 0
  let lastNewline = -1
  let tornTail = null
  for (let i = 0; i < plaintext.length; i++) {
    if (plaintext.charCodeAt(i) === 10) {
      lines.push(plaintext.slice(start, i + 1))
      start = i + 1
      lastNewline = i
    }
  }
  if (start < plaintext.length) {
    tornTail = plaintext.slice(start)
  }

  const report = {
    ok: true, // 日志干净（无分叉、无截断）
    mergeable: false, // 有分叉但可合并修复（无前向空洞/不可解析截断）
    totalLines: lines.length,
    tornTail: tornTail === null ? null : tornTail.length,
    events: 0,
    kept: 0,
    skipped: 0,
    renumbered: 0,
    truncated: null, // { atLine, reason }
    divergence: null, // { atLine, expected, got }
    detail: [],
  }

  if (lines.length === 0) {
    report.ok = false
    report.detail.push('空文件或缺少 header')
    return report
  }

  const header = lines[0]
  let headerMeta = null
  try {
    headerMeta = JSON.parse(header.replace(/\n$/, ''))
  } catch {
    report.ok = false
    report.detail.push('首行 header 不是合法 JSON，无法修复（需人工处理）')
    return report
  }
  if (!headerMeta || typeof headerMeta !== 'object' || typeof headerMeta.id !== 'string') {
    report.ok = false
    report.detail.push('首行 header 缺少 session id，无法修复（需人工处理）')
    return report
  }

  const out = [header]
  let count = 0
  let issueSeen = false

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    let value
    try {
      value = JSON.parse(line.replace(/\n$/, ''))
    } catch {
      // 不可解析的已提交行：与读取器一致，置 issue；修复时从这里截断
      report.ok = false
      if (!issueSeen) {
        issueSeen = true
        report.detail.push(`第 ${i} 行 JSON 不可解析，从该处截断`)
      }
      report.truncated = { atLine: i, reason: 'unparsable line' }
      break
    }
    const range = seqRange(value)
    if (!range) {
      report.ok = false
      if (!issueSeen) {
        issueSeen = true
        report.detail.push(`第 ${i} 行缺少合法 seq/seq0，从该处截断`)
      }
      report.truncated = { atLine: i, reason: 'missing seq' }
      break
    }
    const [lo, hi] = range
    if (lo === count) {
      out.push(line)
      count = hi + 1
      report.kept++
      report.events += hi - lo + 1
      continue
    }
    if (lo < count) {
      // 分叉流：seq 回跳
      if (!issueSeen) {
        issueSeen = true
        report.divergence = { atLine: i, expected: count, got: lo }
        report.detail.push(`第 ${i} 行 seq 回跳（expected ${count}, got ${lo}）——重叠分叉流，开始合并`)
      }
      if (hi < count) {
        report.skipped++
        continue // 完全重叠：丢弃
      }
      // 部分重叠（打包行跨过当前计数）：把 seq0 重编号到当前计数
      const newLine = renumberLine(line, value, count)
      out.push(newLine)
      const size = hi - lo + 1
      count += size
      report.kept++
      report.renumbered++
      report.events += size
      report.detail.push(`第 ${i} 行打包行部分重叠，seq0 ${lo} → ${count - size}`)
      continue
    }
    // lo > count：前向空洞，无法合并 → 截断
    report.ok = false
    if (!issueSeen) {
      issueSeen = true
      report.divergence = { atLine: i, expected: count, got: lo }
      report.detail.push(`第 ${i} 行 seq 前向空洞（expected ${count}, got ${lo}）——从该处截断`)
    }
    report.truncated = { atLine: i, reason: 'forward gap' }
    break
  }

  report.plaintext = out.join('')
  if (!report.truncated && report.divergence) {
    // 重叠分叉被完整跳过、流重新接续：文件可修复
    report.ok = false
    report.mergeable = true
    report.detail.push(`合并完成：${report.events} 个事件（丢弃 ${report.skipped} 行重叠，重编号 ${report.renumbered} 行）`)
  } else if (!report.truncated) {
    report.detail.push(`日志连续：${report.events} 个事件，无分叉`)
  }
  return report
}

/** 把打包行的 seq0（或普通行的 seq）重编号；尽量只改原文字节，失败则 JSON 重建 */
function renumberLine(line, value, newSeq0) {
  const clean = line.endsWith('\n') ? line.slice(0, -1) : line
  const isPacked = value.type === 'text-chunks' || value.type === 'reasoning-chunks' || value.type === 'tool-call-chunks'
  const key = isPacked ? 'seq0' : 'seq'
  const old = value[key]
  const needle = `"${key}":${old}`
  if (clean.includes(needle)) {
    return clean.replace(needle, `"${key}":${newSeq0}`) + '\n'
  }
  // 兜底：JSON 重建（保持 key 顺序）
  const rebuilt = { ...value, [key]: newSeq0 }
  return JSON.stringify(rebuilt) + '\n'
}

// ---------------------------------------------------------------------------
// 读取一个会话日志为纯文本（zstd 拆帧解压 / 纯文本直读）
// ---------------------------------------------------------------------------
function readLogText(file) {
  const raw = fs.readFileSync(file)
  if (file.endsWith('.zstd')) {
    const z = ensureZstd()
    const { frames, tornStart } = scanZstdFrames(raw)
    if (frames.length === 0) {
      throw new Error('empty or header-less Zstandard session log')
    }
    let text = ''
    for (const f of frames) {
      text += z.decompress(raw.subarray(f.start, f.end)).toString('utf8')
    }
    if (tornStart !== undefined) {
      text += `\n<-- torn tail at byte ${tornStart} omitted --!>\n`
    }
    return text
  }
  return raw.toString('utf8')
}

// ---------------------------------------------------------------------------
// 写回（原子：tmp + rename；备份原文件）
// ---------------------------------------------------------------------------
function writeLogText(file, plaintext) {
  const z = ensureZstd()
  const data = file.endsWith('.zstd') ? z.compress(Buffer.from(plaintext, 'utf8')) : Buffer.from(plaintext, 'utf8')
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.repair-tmp-${process.pid}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(dir, `${path.basename(file)}.bak-${stamp}`)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(file, bak)
    fs.renameSync(tmp, file)
    return bak
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 校验：修复后逐事件核对 seq（用 dsh-session 的真实解码器，若可解析到）
// ---------------------------------------------------------------------------
let deepDecode = null
function loadDeepDecoder() {
  if (deepDecode !== null) return deepDecode
  deepDecode = false
  const candidates = []
  const npmRoots = new Set()
  if (process.env.APPDATA) npmRoots.add(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.NODE_PATH) for (const p of process.env.NODE_PATH.split(path.delimiter)) if (p) npmRoots.add(p)
  for (const root of npmRoots) {
    candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
    candidates.push(path.join(root, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
  }
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    try {
      const mod = require(c)
      if (typeof mod.decodeStorageRecord === 'function') {
        deepDecode = mod.decodeStorageRecord
        return deepDecode
      }
    } catch { /* 版本不匹配则跳过 */ }
  }
  return null
}

function verifyEvents(plaintext) {
  const decode = loadDeepDecoder()
  if (!decode) return { checked: false, note: 'dsh-session 不可解析，跳过逐事件校验（范围校验已等价）' }
  const lines = plaintext.split('\n').filter((l) => l.length > 0)
  let count = 0
  for (let i = 1; i < lines.length; i++) {
    let value
    try {
      value = JSON.parse(lines[i])
    } catch {
      return { checked: true, ok: false, at: i, reason: 'JSON 不可解析' }
    }
    let events
    try {
      events = decode(value)
    } catch (e) {
      return { checked: true, ok: false, at: i, reason: `decodeStorageRecord 抛错: ${e.message}` }
    }
    for (const ev of events) {
      if (ev.seq !== count) {
        return { checked: true, ok: false, at: i, reason: `seq ${ev.seq} != 期望 ${count}` }
      }
      count++
    }
  }
  return { checked: true, ok: true, events: count }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function collectLogs() {
  if (wantFile) return [path.resolve(wantFile)]
  const sessionsRoot = path.join(dshHome, 'sessions')
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`sessions 目录不存在: ${sessionsRoot}`)
  }
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') out.push(full)
    }
  }
  walk(sessionsRoot)
  return out.sort()
}

function main() {
  const logs = collectLogs()
  if (logs.length === 0) {
    console.log('未找到任何会话日志。')
    process.exit(0)
  }
  console.log(`Zstandard 实现: ${ensureZstd().kind}`)
  console.log(`检查 ${logs.length} 个会话日志（${wantFix ? '修复模式' : '检查模式'}）\n`)

  let bad = 0
  let fixed = 0
  for (const file of logs) {
    const rel = path.relative(dshHome, file)
    let report
    try {
      report = mergeLog(readLogText(file))
    } catch (e) {
      console.log(`✗ ${rel}\n    读取失败: ${e.message}`)
      bad++
      continue
    }
    if (report.ok) {
      console.log(`✓ ${rel}  (${report.events} 事件, ${report.totalLines} 行)`)
      continue
    }
    bad++
    console.log(`✗ ${rel}${report.mergeable ? '（分叉，可修复）' : ''}`)
    for (const d of report.detail) console.log(`    ${d}`)
    if (report.tornTail) console.log(`    末尾 ${report.tornTail} 字节无换行（torn tail，读取器本会忽略）`)

    if (wantFix) {
      // 只有"可合并修复"（重叠分叉且无前向空洞/不可解析截断）才写回；否则保持原样
      if (report.truncated) {
        console.log(`    存在截断（${report.truncated.reason}），为避免丢数据不自动修复；请人工处理`)
        continue
      }
      try {
        const bak = writeLogText(file, report.plaintext)
        const after = mergeLog(readLogText(file))
        const deep = after.ok ? verifyEvents(after.plaintext) : null
        console.log(`    已修复 → ${after.events} 事件（备份: ${path.basename(bak)}）`)
        if (deep) {
          if (deep.checked && !deep.ok) {
            console.log(`    ⚠ 逐事件校验失败（第 ${deep.at} 行: ${deep.reason}）——请勿继续使用，报告此输出`)
          } else {
            console.log(`    逐事件校验通过（${deep.events} 事件${deep.checked ? '' : '，' + deep.note}）`)
          }
        }
        fixed++
      } catch (e) {
        console.log(`    修复失败: ${e.message}`)
      }
    }
  }

  console.log(`\n${wantFix ? `完成：${fixed} 个已修复` : `检查完成`}，${bad} 个异常（${logs.length - bad} 个正常）`)
  process.exit(bad === 0 || wantFix ? 0 : 1)
}

module.exports = { mergeLog, readLogText, scanZstdFrames, verifyEvents, seqRange, renumberLine }

if (require.main === module) {
  main()
}
