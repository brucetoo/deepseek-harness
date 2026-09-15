# 桌面应用

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 把既有 React 应用与自包含的纯 Node Host 打包为 Electron 应用。Electron 持有窗口、Host sidecar、本地鉴权和应用关闭流程；产品行为仍由既有 Host 与客户端插件实现。

> **注意：** 桌面应用目前是预览功能。打包流程会生成未签名的 macOS arm64 与 Windows x64 开发产物。

## 命令

- `pnpm run desktop:dev` 重新构建并校验 sidecar 暂存目录，然后从 checkout 启动 Electron。
- `pnpm run desktop:stage` 在 `apps/desktop/.stage/versions/` 下发布经过校验的不可变 sidecar 版本，并更新原子指针 `apps/desktop/.stage/current`。
- `pnpm run desktop:package:mac` 在 macOS arm64 上运行，并在 `apps/desktop/dist/` 下写入应用 bundle、ZIP 压缩包和 `SHA256SUMS`。
- `pnpm run desktop:package:win` 在 Windows x64 上运行，并在 `apps/desktop/dist/` 下写入交互式 NSIS 安装程序、ZIP 压缩包和 `SHA256SUMS`。

暂存目录和打包产物均为被忽略的构建输出。

## 运行时

Electron 主进程使用打包的 Node 可执行文件，在 `127.0.0.1:37615` 上启动暂存的 `dsh web` 入口。每次启动都会创建一个 256 位 bearer token。Host 要求每个 HTTP 请求和 WebSocket upgrade 都携带该 token，Electron session 则只为精确的应用 origin 注入它。

`BrowserWindow` 禁用 Node 集成，启用上下文隔离与 Chromium 沙箱，不暴露 preload bridge，拒绝子窗口，并阻止离开应用 origin 的导航。明确的外部 HTTP 与 HTTPS 链接通过操作系统打开。

应用只允许一个实例。第二次启动会聚焦现有窗口。关闭最后一个窗口后，Electron 会先执行有界的 sidecar 关闭流程，再退出。桌面数据使用 Electron `userData` 目录下的 `dsh/` 子目录，不读取用户 CLI 的 `$DSH_HOME`。

## 内置工作流

打包后的 sidecar 会把其确切 Node 可执行文件和只读的 `app/skills` 目录提供给 skill provider。桌面应用内置 `office-docx`、`office-xlsx` 和 `browser-research`。Office 技能使用打包的 `docx` 与 `exceljs` 依赖运行内置 JavaScript 生成器，再通过 `register_artifact` 把二进制输出加入 Session 的**成果**视图。浏览器调研会组合既有 `web_search`、`web_fetch` 与文本文件工具，生成带引用的 Markdown 成果。

**成果**视图从持久的成功修改与登记调用中重建 registry，不维护独立数据库。重新加载和历史分页会重放同一批 Session 事件，文件操作复用已有的 workspace 感知 Host 打开器。

## 暂存与打包

[`apps/desktop-runtime`](../desktop-runtime/package.json) 是显式的 pnpm 部署根目录，列出 Web 组合需要的全部运行时依赖与对等依赖（peer dependency）。暂存流程会构建仓库，创建将 workspace 包注入为文件的生产部署，复制当前 Node 可执行文件，并校验必要资源、生成的 Remote 模块、原生模块导入、Node 版本、可执行权限、符号链接包含关系，以及不依赖 checkout 的 CLI 冒烟测试。

每个暂存版本记录源码 commit、锁文件 SHA-256 摘要、Node 版本、平台与架构。打包只接受与原生 `darwin-arm64` 或 `win32-x64` 目标完全匹配且经过校验的暂存版本，把它放在 ASAR 外的 `Resources/sidecar`，并使用固定版本的本地 Electron 发行包。Windows CI 会验证校验和、展开 ZIP、静默安装 NSIS 软件包、检查内置 sidecar 的目标平台、启动已安装应用直至 React 页面就绪、关闭应用窗口，并确认 sidecar 监听器退出。

## 限制

- 其他进程占用固定端口 `37615` 时，应用会明确报错并停止。
- macOS 产物未签名，也未经过 notarization（公证）；Windows 产物未签名。
- 签名、更新、托盘行为以及最后一个窗口关闭后的后台执行尚未实现。
- 浏览器调研能够获取并汇总网页，但不能点击、填写、登录或控制交互式浏览器会话。
- 内置 Office 工作流能够创建新的 DOCX 与 XLSX 文件；编辑现有 Office 文档、通过 Office 引擎重算工作簿公式以及生成 PPTX 尚未实现。
- 桌面载体使用已鉴权的 loopback HTTP 与 WebSocket 通信，不提供 TLS，也不使用 Electron IPC 传输。
