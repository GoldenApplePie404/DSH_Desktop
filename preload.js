'use strict'

/**
 * preload.js —— 通过 contextBridge 给页面暴露极小的桌面能力。
 * 页面本身跑在沙箱里（nodeIntegration: false + sandbox: true），
 * 只能拿到这里显式暴露的 API。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** 打开外部链接（交给系统默认浏览器） */
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  /** 完全退出应用（含后台 dsh 服务） */
  quit: () => ipcRenderer.send('desktop:quit'),
  /** 桌面环境信息（供 dsh-desktop-bridge 插件读取） */
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  /** 发一条原生通知（供 dsh-desktop-bridge 插件在回答完成时调用） */
  notify: (opts) => ipcRenderer.invoke('desktop:notify', opts),
})
