# 开发日志（DEVELOPMENT LOG）

> 本文档按轮次记录 `dsh-desktop-electron` 的开发进展、验证结果、问题与待办清单。
> 与 `README.md`（面向使用者）互补，本文档面向开发者回溯。

---

## 轮次 1 —— 方案 B：内置 dsh 运行时，实现开箱即用

- **日期**：2026-08-17
- **状态**：✅ 核心完成并验证
- **目标**：让打包版应用**自带 dsh 运行时**（不依赖目标机器安装 Node / dsh），实现真正"双击即用"

### 1.1 背景

用户需求：把应用（安装版/便携版）直接丢给别人，对方**双击即可使用**。

原架构问题（`main.js` 第 67-68 行）：
```javascript
const dshBin = process.env.DSH_DESKTOP_DSH || (isWin ? 'dsh.cmd' : 'dsh')
```
- 启动时从 **PATH 查找 `dsh.cmd`**，依赖目标机器预装 DeepSeek Harness CLI
- 对方无 dsh 环境 → 启动即报「DSH 服务启动超时」，完全不可用
- 安装版（NSIS）与便携版**都只是 Electron 壳**，不包含 dsh

### 1.2 关键调研结论

| 项 | 结论 |
| --- | --- |
| dsh 包位置 | 本机 npm 全局：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（v0.1.0-rc.6） |
| dsh 包大小 | 含依赖共 **245.8 MB、32976 文件** |
| **原生模块** | dsh 依赖 `sharp` / `koffi` / `node-pty` / `node-addon-require-builtin`（.node 文件） |
| ABI 匹配 | 原生模块针对 **Node v24.17.0**（本机 `D:\NodeJS\node.exe`）编译 |
| **关键推论** | ❌ 不能用 Electron 内置 Node（Electron 33 内置 Node 20，ABI 不匹配）→ **必须随包携带 node.exe** |
| node.exe | `D:\NodeJS\node.exe`，88 MB |
| bridge-plugin 依赖 | peerDep: `@deepseek-ai/cordis` ^4.0.1；事件: `session/event` / `assistant/message` |

### 1.3 实施改动

#### ① `vendor/dsh/`（新增，333.8 MB，32977 文件）

内置 dsh 运行时目录（`.gitignore` 已忽略，不入库）：
```
vendor/dsh/
├── node.exe                                # Node v24.17.0（与原生模块 ABI 匹配）
└── node_modules/@deepseek-ai/dsh/          # dsh 及全部依赖（含原生模块）
```
来源：`robocopy` 从全局 npm 目录复制（耗时约 30 分钟，32976 文件 0 失败）。

#### ② `package.json`

- 新增顶层 `productName: "DeepSeek Harness Desktop"` —— 统一 Electron `userData` 目录为 `%APPDATA%\DeepSeek Harness Desktop`（此前实际落在 `%APPDATA%\dsh-desktop-electron`，与 README 描述不符）
- 新增 `extraResources`：把 `vendor/dsh` 打包进应用 `resources/dsh`
  ```json
  "extraResources": [
    { "from": "vendor/dsh", "to": "dsh", "filter": ["**/*"] }
  ]
  ```

#### ③ `main.js`

- 新增 `bundledDsh()`：打包后（`app.isPackaged`）检查 `process.resourcesPath/dsh/node.exe` + `.../bin.js` 是否存在
- `spawnDsh()` 改为三级优先级：
  ```
  DSH_DESKTOP_DSH 环境变量（用户显式指定）  >  打包内置 resources/dsh  >  PATH 中的 dsh
  ```
- 内置模式：`spawn(node.exe, [bin.js, --profile web, --port, ...])`，`shell: false`

#### ④ `README.md`

更新：功能列表加"开箱即用"、配置表 `DSH_DESKTOP_DSH` 优先级说明、目录结构加 `vendor/dsh/`、工作原理更新 spawn 分支、规划清单勾选完成项。

### 1.4 验证过程与结果

#### ① vendor 内置 dsh 本地验证
```powershell
vendor\dsh\node.exe vendor\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --version
# → 0.1.0-rc.6 ✅
```
启动 web 服务 → `dsh web: http://127.0.0.1:18999` → HTTP 200 ✅

#### ② 冒烟测试方法（关键）
```powershell
$env:Path = "C:\Windows\System32;C:\Windows"   # 干净 PATH：模拟无 Node / 无 dsh 的目标机器
$env:DSH_DESKTOP_SMOKE = "1"
Start-Process "<exe>"                          # 启动后轮询 %APPDATA%\DeepSeek Harness Desktop\dsh-desktop.log 找 SMOKE_OK
```

#### ③ 各分发形式验证结果（均干净 PATH）

| 分发形式 | 文件 | 结果 |
| --- | --- | --- |
| 解包目录 | `release/win-unpacked/` | ✅ SMOKE_OK |
| zip 解压版（手动 tar 打包） | `DeepSeek Harness Desktop 0.1.0-win.zip`（222.3 MB） | ✅ SMOKE_OK |
| NSIS 安装版（短路径安装 `C:\dsh-test4`） | `Setup 0.1.0.exe`（157.3 MB） | ✅ SMOKE_OK（33052 文件完整） |
| 便携版 | `DeepSeek Harness Desktop 0.1.0.exe`（156.7 MB） | ❌ SFX 解压卡死（见 1.5） |

典型成功日志：
```
[..] userData: C:\Users\czhdq\AppData\Roaming\DeepSeek Harness Desktop
[..] spawn bundled dsh: ...\resources\dsh\node.exe ...\bin.js --profile web --port 53603
[..] DSH ready at http://127.0.0.1:53603
[..] SMOKE_OK
```

### 1.5 发现的问题与根因

#### ⚠️ 问题 1：NSIS 安装到长路径会静默丢文件（Windows MAX_PATH 260 限制）

- **现象**：安装到 `%TEMP%\dsh-install-test2`（49 字符）只装了 **18595/32977** 文件；安装到 `C:\dsh-test4`（11 字符）**33052 文件完整**
- **根因**：dsh 依赖树中最长文件路径达 **214 字符**（`...\@opentelemetry\otlp-transformer\node_modules\@opentelemetry\...\getMachineId-unsupported.js.map`）。安装目标路径 + 214 > 260 的文件被 NSIS 静默跳过
- **影响评估**：
  - ✅ 正常安装到 `C:\Program Files\DeepSeek Harness Desktop\`（37 字符，合计 251 < 260）**无问题**
  - ⚠️ 用户自定义安装到很深的目录才有风险
- **曾误判**：最初以为 electron-builder 归档丢文件（在 Setup.exe 二进制中搜不到 `js-yaml` 字符串），后确认是**压缩归档后字符串不可见**，方法错误；真实根因是**安装解压环节的路径长度**

#### ⚠️ 问题 2：便携版 SFX 解压卡死

- **现象**：运行便携版 300+ 秒无反应（进程存活、CPU 100%、`nsp*.tmp` 0 字节不增长）
- **疑似根因**：portable 解压到 `%TEMP%`（长路径），与问题 1 同源（nsis7z 处理超长路径文件时卡死）；未完全证实
- **状态**：待修复（见 TodoList）

#### ℹ️ 附带修正

- 打包版 `userData` 路径：`%APPDATA%\dsh-desktop-electron` → `%APPDATA%\DeepSeek Harness Desktop`（`productName` 生效，与 README 一致）
- `DSH_DESKTOP_DSH` 优先级曾低于内置运行时（显式指定被忽略），已修正为最高优先级

### 1.6 最终产物（release/）

| 文件 | 大小 | 状态 | 备注 |
| --- | --- | --- | --- |
| `DeepSeek Harness Desktop Setup 0.1.0.exe` | 157.3 MB | ✅ 可用 | NSIS 安装版，正常安装路径无问题 |
| `DeepSeek Harness Desktop-0.1.0-win.zip` | 212.5 MB | ✅ **推荐分发** | electron-builder zip target，解压后双击 exe 即用 |
| `DeepSeek Harness Desktop 0.1.0.exe` | 156.7 MB | ❌ 待修 | 便携版 SFX 卡死 |

> 曾生成手动 tar 版 zip（`DeepSeek Harness Desktop 0.1.0-win.zip`，222.3 MB）用于验证归档完整性，与 electron-builder 版内容一致、仅压缩参数不同，已删除避免混淆（2026-08-17）。
> 打包提示：electron-builder 末尾偶发返回码 1（产物已生成且可用），以 release/ 产物为准。
> PowerShell 中 `npm` 命令会被 npm.ps1 执行策略拦截，需用 `npm.cmd` 或 `& "D:\NodeJS\npm.cmd"`。

---

## 轮次 2 —— dsh-web-ui 集成（调研与规划，暂未动工）

- **日期**：2026-08-17
- **状态**：📋 调研完成，待立项
- **目标**：集成 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（DSH Web GUI 插件与皮肤全家桶）到桌面壳分发版

### 2.1 它是什么

dsh-web-ui（[GitHub](https://github.com/zhu1090093659/dsh-web-ui)，Apache-2.0，npm `@linxin666/*`）是给 DeepSeek Harness Web GUI 的插件/皮肤集合：

| 插件 | 功能 |
| --- | --- |
| 梁神模式 | 面向 V4 Pro 的两阶段 agent 预设（Minimal 开局 → PTC 完整工具） |
| 任务看板 | 多列看板 + cron 定时真实执行（Host 调度，关浏览器也跑） |
| Git 图谱 | 分支泳道 + 提交历史可视化 |
| 右侧面板 | 文件树 / 预览（md/html/PDF/Office…）/ SCM 变更面板 |
| 移动端远程 | 扫码配对，SSE 实时同步 |
| SSH 运维 | Web 终端 / SFTP / 端口转发 / 集群执行 / Agent 直连 |
| 图像理解 | `describe_image` 视觉工具（Qwen-VL、GLM-4V、GPT-4o、Ollama 等） |
| 鲸鱼娘宠物 / 实时吞吐 | 陪伴动画、token 实时 TPS 统计 |
| 皮肤中心 | 11 款皮肤，先试穿再应用（含 Maid Atelier） |

安装（官方 profile 机制）：
```sh
dsh plugin --profile web add @linxin666/dsh-web-ui-all   # 全家桶
dsh plugin --profile web add @linxin666/dsh-skins        # 只要皮肤
```

### 2.2 兼容性结论：✅ 架构友好

- 插件全部走**官方 profile 机制**挂载到 `dsh web`，不改 DSH 源码 → 与"壳"架构天然兼容，**Electron 侧零代码改动**
- 桌面版复用同一 `$DSH_HOME` → 装了插件，桌面版窗口自动生效
- 与现有桌面桥插件（bridge-plugin）共存无冲突
- 与内置 dsh 运行时（vendor/dsh）无冲突（插件装在 profile 用户数据，运行时只是 dsh 本体）

### 2.3 集成方式（3 个层次）

| 方案 | 做法 | 场景 |
| --- | --- | --- |
| A. 用户自装（零开发） | 文档引导执行 `dsh plugin --profile web add @linxin666/dsh-web-ui-all` | 最快验证；需网络 |
| B. 首次启动引导安装 | 壳检测 profile 缺插件 → 提示/自动执行安装命令（需网络） | 半自动 |
| C. 离线预置（完整分发） | 下载 npm 包（含 11 子包依赖）进 `vendor/`，壳首次启动离线写入 profile | **真正开箱即用**，与方案 B 思路一致 |

> 推荐路线：A 验证 → C 落地。

### 2.4 ⚠️ 风险清单

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| pnpm 11 版本门禁 | `minimumReleaseAge` 静默装旧版（issue #71，旧版应用皮肤后 dsh 启动崩溃 `ERR_MODULE_NOT_FOUND`） | profile `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['@linxin666/*']` |
| pnpm 严格布局 | 聚合包 12 行 insert 子包被收进嵌套 → `Cannot find package` | profile 设 `nodeLinker: hoisted` |
| 许可证 | 聚合包 Apache-2.0 ✅；**Maid Atelier 皮肤单独 CC BY-NC-SA 4.0（非商业）** | 分发前确认合规 |
| 第三方活跃度 | 社区插件迭代快 | 跟踪上游、锁版本 |
| 体积 | 11 插件 + 11 皮肤，预计数十 MB | 可只装皮肤瘦身 |
| 安全模型 | SSH 密码明文存 `~/.dsh/dsh-ssh.json`；远程输出不脱敏 | 文档明示，默认关闭 |

### 2.5 执行路径（若立项）

1. **阶段 A（验证兼容）**：开发机 web profile 装全家桶 → 重启 dsh web → 桌面版确认插件入口/皮肤中心出现，验证与桌面桥、崩溃自愈无冲突
2. **阶段 B（离线预置）**：下载 `@linxin666/dsh-web-ui-all` 及依赖进 `vendor/` → 壳首次启动离线安装（处理 pnpm-workspace.yaml）
3. **阶段 C（打磨）**：皮肤中心与 Maid Atelier 协调、SSH 等桌面场景适配、体积优化

### 2.6 一句话结论

✅ 非常值得做：架构完全兼容（官方插件机制）、功能丰富（看板/Git/SSH/移动端/皮肤中心）、Apache-2.0 许可友好；主要工作量在**离线依赖预置**（pnpm 布局处理），壳本身几乎不用改。

---

## TodoList

### ✅ 已完成（本轮）

- [x] 定位 dsh 包（npm 全局 `@deepseek-ai/dsh` v0.1.0-rc.6）与原生模块 ABI 约束（需 Node 24）
- [x] 创建 `vendor/dsh/` 内置运行时（node.exe 88MB + dsh 完整树 245MB）
- [x] `package.json`：`extraResources` 打包配置 + 顶层 `productName`
- [x] `main.js`：`bundledDsh()` 三级优先级（环境变量 > 内置 > PATH）
- [x] vendor 内置 dsh 本地验证（`--version` ✅、web 服务 HTTP 200 ✅）
- [x] `dist:dir` 打包 + 干净 PATH 冒烟验证（SMOKE_OK ✅）
- [x] 完整打包（NSIS + portable + zip）与三种分发验证（win-unpacked / zip / NSIS 短路径均 SMOKE_OK ✅）
- [x] 根因排查：NSIS 长路径丢文件（MAX_PATH 260）、便携版 SFX 卡死
- [x] README 更新（开箱即用、目录结构、工作原理）

### ⏳ 待办 —— 轮次 1 遗留

- [ ] **根治长路径问题**：精简 `vendor/dsh` 依赖树（如移除 web 模式用不到的深层嵌套依赖：`@opentelemetry`、`@aws-sdk`、`@mistralai` 等第三方 SDK，或调整目录层级），把最长相对路径 214 字符降到 < 150，使便携版与任意深度安装路径均可靠
- [ ] 修复/验证便携版（SFX 卡死）
- [ ] 更新内置 dsh 版本流程文档化（`npm install --prefix vendor/dsh @deepseek-ai/dsh` 重装后重新打包）
- [ ] 自动化冒烟测试脚本（clean PATH + SMOKE 一键验证）

### ⏳ 待办 —— 轮次 2（dsh-web-ui 集成，规划中）

- [ ] 阶段 A：开发机 web profile 装 `@linxin666/dsh-web-ui-all`，验证与桌面壳/桌面桥兼容（插件入口、皮肤中心、SMOKE）
- [ ] 阶段 B：离线预置——下载全家桶及依赖进 `vendor/`，壳首次启动离线写入 profile（处理 `pnpm-workspace.yaml`：`nodeLinker: hoisted` + `minimumReleaseAgeExclude`）
- [ ] 阶段 C：皮肤中心与 Maid Atelier 协调、SSH 端口转发桌面场景适配、体积优化（按需选装）
- [ ] 许可证复核：Maid Atelier（CC BY-NC-SA 4.0 非商业）在分发版中的合规处理

---

## 附：常用命令

```powershell
# 开发模式启动（需要 PATH 中有 dsh）
npm start

# 打包
npm run dist          # NSIS 安装版 + 便携版
npm run dist:dir      # 解包目录（调试）

# 干净环境冒烟验证（打包后）
$env:Path = "C:\Windows\System32;C:\Windows"
$env:DSH_DESKTOP_SMOKE = "1"
Start-Process "release\win-unpacked\DeepSeek Harness Desktop.exe"
# 轮询 %APPDATA%\DeepSeek Harness Desktop\dsh-desktop.log 中的 SMOKE_OK

# 会话日志修复
npm run repair
```
