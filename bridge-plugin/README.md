# dsh-desktop-bridge

DSH 桌面桥插件（host 面）：把 DSH 会话事件桥接到 Electron 壳的原生能力。

## 工作原理

```
dsh web 进程内（本插件）                      Electron 主进程
──────────────────────                      ─────────────────
ctx.on('session/event') ──POST──▶ 本地 IPC 服务 ──▶ 原生通知
  assistant/message         (127.0.0.1 随机端口
                             + 随机令牌 X-Token)
```

壳启动 `dsh --profile web` 时注入环境变量 `DSH_DESKTOP_IPC_URL` / `DSH_DESKTOP_IPC_TOKEN`；
没有这两个变量（普通网页版）时插件静默，完全不影响网页端。

## 能力

- `assistant/message` → 原生通知「响应完成」（2 秒限频，预览 100 字）
- 自检：`DSH_DESKTOP_BRIDGE_SELF_TEST=1` 时挂载后发一条测试通知

## 依赖说明* **peerDep**：`@deepseek-ai/cordis` ^4.0.1（见 package.json）* **事件订阅**：`session/event`（global）、`assistant/message`* **无 IPC 环境变量时静默**：不影响普通网页版## 安装

```sh
dsh plugin --profile web add <本目录>
```

（桌面壳项目内已配置好 junction 与安装流程；卸载 `dsh plugin --profile web remove dsh-desktop-bridge`）

## 扩展思路

- `approval/asked` → 「需要你的批准」通知
- `tool/result` 出错 → 失败通知
- 托盘菜单动态项、原生文件对话框 → 通过 IPC 端点暴露
