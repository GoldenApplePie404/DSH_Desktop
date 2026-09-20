/**
 * dsh-desktop-bridge —— 桌面桥插件（host 面）
 *
 * 把 DSH 侧会话事件桥接到 Electron 壳的本地 IPC 服务。
 * 壳启动 `dsh --profile web` 时通过环境变量注入通道信息：
 *   DSH_DESKTOP_IPC_URL    e.g. http://127.0.0.1:54321
 *   DSH_DESKTOP_IPC_TOKEN  随机令牌（壳与插件共享）
 * 在普通网页版（无 IPC 环境变量）下，本插件安静地什么都不做。
 *
 * 当前桥接能力：
 *   - assistant/message → 原生通知「响应完成」（限频，避免刷屏）
 * 自检：DSH_DESKTOP_BRIDGE_SELF_TEST=1 时挂载后发一条测试通知。
 */

export const name = 'desktop-bridge'

const MIN_NOTIFY_GAP_MS = 2000
const PREVIEW_MAX = 100
let lastNotifyAt = 0

/** 从 assistant 消息的 ContentBlock[] 里提取纯文本预览 */
function previewOf(message) {
  const text = (message?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim()
  if (!text) return '(无文本内容)'
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text
}

export function apply(ctx) {
  const url = process.env.DSH_DESKTOP_IPC_URL
  const token = process.env.DSH_DESKTOP_IPC_TOKEN
  if (!url || !token) return // 非桌面壳环境：静默

  const send = (title, body) => {
    const now = Date.now()
    if (now - lastNotifyAt < MIN_NOTIFY_GAP_MS) return
    lastNotifyAt = now
    fetch(`${url}/v1/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token },
      body: JSON.stringify({ title, body: String(body).slice(0, 200) }),
    }).catch((e) => console.error('[desktop-bridge] notify failed:', e.message))
  }

  // 全局监听所有会话的追加事件（与 dsh-session-invariant 同款写法）
  ctx.on(
    'session/event',
    (session, event) => {
      if (!event || event.type !== 'assistant/message') return
      const title = typeof session?.title === 'string' && session.title ? `DSH · ${session.title}` : 'DeepSeek Harness'
      send(title, previewOf(event.data?.message))
    },
    { global: true }
  )

  if (process.env.DSH_DESKTOP_BRIDGE_SELF_TEST === '1') {
    setTimeout(() => send('桌面桥自检', 'DSH → Electron IPC 通道正常'), 500)
  }
}
