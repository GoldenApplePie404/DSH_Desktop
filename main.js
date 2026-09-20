'use strict'

/**
 * dsh-desktop-electron —— DeepSeek Harness 桌面壳（最小版 + 桌面桥）
 *
 * 架构：桌面壳 = 启动器 + 窗口，绝不重写 DSH。
 *   1. 动态选一个空闲本地端口
 *   2. 启动本地 IPC 服务（127.0.0.1 随机端口 + 随机令牌），供桥插件回调
 *   3. 以子进程启动 `dsh --profile web --port <port>`，注入 IPC 通道环境变量
 *   4. 轮询等服务就绪 → 原生窗口加载 http://127.0.0.1:<port>
 *   5. 关窗 = 藏托盘；退出 = 杀干净 dsh 进程树
 *   6. 崩溃自愈：dsh 意外退出自动重启一次
 *   7. 开机自启开关（托盘 + IPC 端点）
 *   8. 并发防护：检测到其他 dsh web 实例时警告并默认取消启动（防会话日志损坏）
 *
 * 桌面桥插件（bridge-plugin/）：DSH host 插件订阅会话事件，POST 到本 IPC
 * 服务 → 原生通知。未注入 IPC 环境变量时插件静默，网页版不受影响。
 *
 * 会话日志修复：`npm run repair`（scripts/repair-session-log.cjs）——两个 dsh
 * 实例并发写同一会话会留下 seq 分叉，导致历史无法加载；该工具合并修复。
 */

const {
  app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain, dialog, Notification,
} = require('electron')
const { spawn, spawnSync, execFile } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const isWin = process.platform === 'win32'
const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
function logFile() {
  return path.join(app.getPath('userData'), 'dsh-desktop.log')
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(logFile(), line + '\n')
  } catch { /* 日志失败不影响运行 */ }
}

// ---------------------------------------------------------------------------
// 参数 / 环境
// ---------------------------------------------------------------------------
function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const workspace =
  argValue('--workspace') ||
  process.env.DSH_DESKTOP_WORKSPACE ||
  path.join(os.homedir(), 'DSHWorkspace')
const fixedPort =
  Number(argValue('--port') || process.env.DSH_DESKTOP_PORT || 0) || 0
// dsh 可执行文件：DSH_DESKTOP_DSH 显式指定 > 打包内置（resources/dsh）> PATH
const dshBin =
  process.env.DSH_DESKTOP_DSH || (isWin ? 'dsh.cmd' : 'dsh')

/**
 * 打包内置的 dsh 运行时（方案 B：开箱即用）。
 * electron-builder 通过 extraResources 把 vendor/dsh 复制到 resources/dsh，
 * 内含 node.exe（Node LTS）与 @deepseek-ai/dsh 完整依赖树（含原生模块）。
 * 返回 { nodeBin, entry }；开发模式或目录缺失时返回 null（回退 PATH）。
 */
function bundledDsh() {
  if (!app.isPackaged) return null
  const root = path.join(process.resourcesPath, 'dsh')
  const nodeBin = path.join(root, isWin ? 'node.exe' : 'node')
  const entry = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(nodeBin) && fs.existsSync(entry)) return { nodeBin, entry }
  return null
}

// ---------------------------------------------------------------------------
// 并发 dsh web 实例检测（根因防护）
//
// 背景：两个 dsh web 实例同时打开同一个会话时（网页版 + 桌面版并存），各自
// 持有独立的 seq 计数器并向同一 session.jsonl[.zstd] 追加行，日志出现 seq
// 回跳/重叠的"分叉流"，导致「历史加载失败：corrupt session log: seq gap」。
// 启动前枚举进程命令行，发现其他 `dsh ... --profile web` / `dsh web` 实例时
// 弹窗警告（默认取消启动），避免数据再次损坏。
// ---------------------------------------------------------------------------
function findOtherDshWeb() {
  return new Promise((resolve) => {
    const script = [
      '$ps = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
      'foreach ($p in $ps) {',
      '  if (-not $p.CommandLine) { continue }',
      '  $cl = $p.CommandLine',
      '  $isDshWeb = ($cl -match "dsh") -and ($cl -match "--profile\\s+web" -or $cl -match "(^|[\\s/])web([\\s]|$)")',
      '  if ($isDshWeb) { "{0}`t{1}`t{2}" -f $p.ProcessId, $p.Name, $cl }',
      '}',
    ].join('; ')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        log('instance check: powershell failed:', err.message)
        return resolve([]) // 检测失败不阻塞启动（fail-open）
      }
      const others = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^(\d+)\t([^\t]*)\t(.*)$/)
        if (!m) continue
        const pid = Number(m[1])
        if (pid === process.pid) continue
        others.push({ pid, name: m[2], cmdline: m[3] })
      }
      resolve(others)
    })
  })
}

// ---------------------------------------------------------------------------
// 动态端口
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

// ---------------------------------------------------------------------------
// 本地 IPC 服务（桌面桥通道）—— 只信本机回环 + 随机令牌
// ---------------------------------------------------------------------------
let ipcServer = null
let ipcPort = 0
let ipcToken = ''

function startIpcServer() {
  ipcToken = crypto.randomBytes(16).toString('hex')
  ipcServer = http.createServer((req, res) => {
    const addr = req.socket.remoteAddress
    if (!(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')) {
      res.writeHead(403); return res.end('forbidden')
    }
    if (req.headers['x-token'] !== ipcToken) {
      res.writeHead(401); return res.end('unauthorized')
    }
    const chunks = []
    req.on('data', (c) => {
      chunks.push(c)
      if (Buffer.concat(chunks).length > 1e6) req.destroy()
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      } catch {
        res.writeHead(400); return res.end('bad json')
      }
      if (req.method === 'POST' && req.url === '/v1/notify') {
        showNotification(String(payload.title || PRODUCT_NAME), String(payload.body || ''))
        return res.end('ok')
      }
      if (req.method === 'POST' && req.url === '/v1/autostart') {
        setAutoStart(Boolean(payload.enabled))
        return res.end('ok')
      }
      if (req.method === 'GET' && req.url === '/v1/status') {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ autoStart: isAutoStartEnabled() }))
      }
      res.writeHead(404); res.end()
    })
  })
  ipcServer.listen(0, '127.0.0.1', () => {
    ipcPort = ipcServer.address().port
    log(`IPC server on 127.0.0.1:${ipcPort}`)
  })
}

function showNotification(title, body) {
  try {
    if (!Notification.isSupported()) {
      log('notification: not supported on this platform')
      return
    }
    new Notification({ title, body, icon: iconPath() }).show()
    log(`notification: ${title} | ${body}`)
  } catch (e) {
    log('notification failed:', e.message)
  }
}

// ---------------------------------------------------------------------------
// 开机自启（仅打包后生效；开发模式下为 no-op）
// ---------------------------------------------------------------------------
function setAutoStart(enabled) {
  if (!app.isPackaged) {
    log('autostart: only supported in packaged app')
    return
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  log(`autostart -> ${enabled}`)
}
function isAutoStartEnabled() {
  if (!app.isPackaged) return false
  return app.getLoginItemSettings().openAtLogin
}

// ---------------------------------------------------------------------------
// dsh web 子进程（含崩溃自愈）
// ---------------------------------------------------------------------------
let dsh = null
let dshPort = 0 // 兜底杀进程用：退出时校验端口确已释放
let isQuitting = false
let dshRestarts = 0
const MAX_RESTARTS = 1

function spawnDsh(port) {
  const args = ['--profile', 'web', '--port', String(port), '--host', '127.0.0.1']

  const env = { ...process.env }
  if (ipcPort) {
    env.DSH_DESKTOP_IPC_URL = `http://127.0.0.1:${ipcPort}`
    env.DSH_DESKTOP_IPC_TOKEN = ipcToken
  }

  // dsh 运行时优先级：DSH_DESKTOP_DSH 显式指定 > 打包内置（resources/dsh）> PATH
  const explicitDsh = process.env.DSH_DESKTOP_DSH
  const bundled = bundledDsh()
  let command, args_, useShell
  if (explicitDsh) {
    command = explicitDsh
    args_ = args
    useShell = isWin // 显式指定多为 .cmd / 脚本，经 cmd 启动
    log(`spawn dsh (explicit): ${command} ${args.join(' ')}  cwd=${workspace}`)
  } else if (bundled) {
    command = bundled.nodeBin
    args_ = [bundled.entry, ...args]
    useShell = false
    log(`spawn bundled dsh: ${command} ${args_.join(' ')}  cwd=${workspace}`)
  } else {
    command = dshBin
    args_ = args
    useShell = isWin // Windows 上 dsh.cmd 必须经 cmd 启动
    log(`spawn ${dshBin} ${args.join(' ')}  cwd=${workspace}`)
  }

  const child = spawn(command, args_, {
    cwd: workspace,
    env,
    shell: useShell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => log('[dsh]', String(d).trim()))
  child.stderr.on('data', (d) => log('[dsh]', String(d).trim()))
  child.on('error', (e) => log('dsh spawn error:', e.message))
  child.on('exit', (code, sig) => onDshExit(code, sig, port))
  return child
}

async function onDshExit(code, sig, port) {
  log(`dsh exited code=${code} sig=${sig}`)
  if (isQuitting || SMOKE) return

  if (dshRestarts < MAX_RESTARTS) {
    dshRestarts++
    log(`dsh exited unexpectedly — restarting (${dshRestarts}/${MAX_RESTARTS})…`)
    await new Promise((r) => setTimeout(r, 1500))
    dsh = spawnDsh(port)
    const ok = await waitForReady(`http://127.0.0.1:${port}`, 60000)
    if (ok && win && !win.isDestroyed()) {
      log('dsh restarted OK, reloading window')
      win.loadURL(`http://127.0.0.1:${port}`)
    } else {
      dialog.showErrorBox(PRODUCT_NAME, 'DSH 服务重启失败。\n日志位置：' + logFile())
      app.quit()
    }
  } else {
    dialog.showErrorBox(PRODUCT_NAME, 'DSH 后台服务连续退出，应用即将关闭。\n日志位置：' + logFile())
    app.quit()
  }
}

// ---------------------------------------------------------------------------
// 等待服务就绪
// ---------------------------------------------------------------------------
async function waitForReady(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch { /* 未就绪，继续轮询 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---------------------------------------------------------------------------
// 主窗口 / 托盘
// ---------------------------------------------------------------------------
let win = null
let tray = null

function iconPath() {
  return path.join(__dirname, 'assets', 'icon.png')
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: PRODUCT_NAME,
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // 渲染进程沙箱：页面永远没有 Node 能力
    },
  })

  win.loadURL(url)

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(u)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith('http://127.0.0.1') && !u.startsWith('http://localhost')) {
      e.preventDefault()
      shell.openExternal(u)
    }
  })
}

function createTray(url) {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip(PRODUCT_NAME)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '在浏览器中打开', click: () => shell.openExternal(url) },
      { label: '打开日志目录', click: () => shell.openPath(path.dirname(logFile())) },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: isAutoStartEnabled(),
        click: (item) => setAutoStart(item.checked),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  )
  tray.on('double-click', () => showMainWindow())
}

function showMainWindow() {
  if (!win) return
  win.show()
  win.focus()
}

// ---------------------------------------------------------------------------
// 干净退出
// ---------------------------------------------------------------------------
/** 查 127.0.0.1:<port> 上 LISTENING 的 PID（无则 null） */
function pidListeningOn(port) {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).stdout || ''
    const m = out.match(new RegExp(`\\b127\\.0\\.0\\.1:${port}\\b\\s+\\S+\\s+LISTENING\\s+(\\d+)`))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

function killDshTree() {
  if (dsh && dsh.pid !== undefined) {
    try {
      if (isWin) {
        spawnSync('taskkill', ['/pid', String(dsh.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        try { process.kill(-dsh.pid, 'SIGTERM') } catch { dsh.kill('SIGTERM') }
      }
      log('dsh process tree killed')
    } catch (e) {
      log('kill failed:', e.message)
    }
  }
  // 兜底：确认 dsh 端口已释放。若仍被占用（例如 taskkill 只杀掉了 cmd 包装
  // 进程、真正的 node 服务成了孤儿），按端口找出占用进程再杀一次。
  if (isWin && dshPort) {
    const holder = pidListeningOn(dshPort)
    if (holder) {
      try {
        spawnSync('taskkill', ['/pid', String(holder), '/t', '/f'], { stdio: 'ignore' })
        log(`port ${dshPort} still held by pid ${holder} — killed as orphan`)
      } catch (e) {
        log('port kill failed:', e.message)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    fs.mkdirSync(workspace, { recursive: true })
    log(`workspace: ${workspace}`)
    log(`userData: ${app.getPath('userData')}`)

    startIpcServer()

    // 根因防护：若已有其他 dsh web 实例在跑，警告并默认取消启动
    if (!SMOKE) {
      const others = await findOtherDshWeb()
      if (others.length > 0) {
        const names = others.map((o) => `PID ${o.pid} (${o.name})`).join('、')
        log('检测到其他 dsh web 实例:', names)
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          title: PRODUCT_NAME,
          message: '检测到另一个 dsh web 实例正在运行',
          detail:
            `检测到：${names}\n\n` +
            '两个 dsh 实例同时读写同一会话目录（$DSH_HOME）会损坏会话日志，' +
            '导致「历史加载失败 / corrupt session log」无法读取历史。\n\n' +
            '建议先关闭网页版或其他实例，再启动桌面版。\n\n' +
            '仍要启动吗？',
          buttons: ['取消启动（推荐）', '仍要启动'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        if (choice === 0) {
          log('用户取消启动（检测到其他 dsh web 实例）')
          app.quit()
          return
        }
        log('用户选择仍要启动（存在会话日志损坏风险）')
      }
    }

    const port = fixedPort || (await getFreePort())
    const url = `http://127.0.0.1:${port}`
    dshPort = port

    dsh = spawnDsh(port)

    const ready = await waitForReady(url)
    if (!ready) {
      dialog.showErrorBox(PRODUCT_NAME, 'DSH 服务启动超时。\n日志位置：' + logFile())
      app.quit()
      return
    }
    log(`DSH ready at ${url}`)

    createWindow(url)
    createTray(url)

    if (SMOKE) {
      win.webContents.once('did-finish-load', () => {
        log('SMOKE_OK')
        setTimeout(() => app.quit(), 500)
      })
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    killDshTree()
  })

  app.on('window-all-closed', () => {
    /* 托盘应用：所有窗口关闭后留在后台 */
  })
}

// preload 桥
ipcMain.handle('desktop:open-external', (_e, u) => {
  if (typeof u === 'string' && /^https?:\/\//.test(u)) shell.openExternal(u)
})
ipcMain.on('desktop:quit', () => app.quit())
