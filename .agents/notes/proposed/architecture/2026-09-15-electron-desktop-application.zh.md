# Agent Note: 使用已鉴权本地 Host 的 Electron 桌面应用

Status: proposed

[English](2026-09-15-electron-desktop-application.md) | 中文

## Problem

DeepSeek Harness 已提供浏览器应用和 CLI（命令行界面），但尚未提供可安装的桌面应用。桌面可执行文件必须启动既有 Host 与 React 客户端，不要求单独安装 Node.js 运行时；还必须阻止无关本地页面和进程访问 Host、持有 Host 进程生命周期，并打包选定组合所需的精确运行时闭包。

既有 GUI 架构曾设想 Electron IPC 传输，并声明 Electron 不使用 `dsh-host-webserver`。先实现该传输意味着必须为每条 HTTP 路由、WebSocket 流、动态插件 bundle、静态资源和下载行为建设第二套载体，之后首个桌面构建才能运行既有产品。当前 Web 载体已经提供这些行为，但 loopback 可达性与浏览器来源检查并非鉴权：其他本地进程可以直接连接，浏览器也能访问已知端口。

桌面打包还会引入另一类失败。开发 checkout 可以解析 workspace 符号链接、生成的 Remote 模块、原生依赖以及机器上安装的 Node.js 可执行文件，而已安装应用不能假定这些条件存在。能从源码启动不等于已暂存的应用能够自包含运行。

## Proposal

在 `apps/desktop` 下新增 Electron 应用，持有一个加固的 `BrowserWindow` 和一个独立的纯 Node Host sidecar。首个实现以未签名的 macOS arm64 开发产物为目标。Windows 打包仍属于设计范围，但 Windows 产物通过相同的暂存运行时与应用测试之前，不宣称支持 Windows。

sidecar 使用普通 Web 组合运行构建后的 `dsh web` 入口，固定使用 loopback 端口 `37615`、禁用浏览器自动打开，并通过专用环境变量传入每次启动重新生成的 256 位 bearer token。Electron 主进程在加载应用 origin 前等待 stdout 中恰好一条规范就绪行。超时、提前退出、就绪行错误或重复、端口冲突、暂存文件缺失以及导航失败都以分类诊断终止启动。

`dsh-host-webserver` 新增可选 bearer 鉴权，并在激活时从指定环境变量解析凭证。配置后，它在路由选择前拒绝每个 HTTP 请求和 upgrade 请求，覆盖静态文件、动态插件 bundle、下载、API 调用和事件流。它精确比较 `Authorization: Bearer <token>`，且不记录 token。普通 `dsh web` 只有在显式配置该选项时才启用鉴权。

Electron session 只为精确的 `http://127.0.0.1:37615` origin 注入 bearer 标头，不向重定向、子资源或其他 origin 的请求附加该标头。窗口使用 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`，不暴露通用 preload bridge，拒绝新窗口，阻止离开应用 origin 的导航，并通过操作系统打开明确的外部 HTTP 或 HTTPS 链接。

应用只允许一个实例。第二次启动只聚焦已有窗口，不启动第二个 Host。关闭最后一个窗口即退出应用。退出流程先请求 sidecar 终止并有界等待，使会话状态能够落盘；随后升级为强制终止，并报告这次升级，不遗留子进程。

## Packaged runtime

`desktop:stage` 命令构建 Host 包和 Web 资源，为 `@deepseek-ai/dsh` 创建经过筛选的生产依赖闭包，将部署时链接实体化，并把该闭包与 `process.execPath` 的精确副本放在 ASAR 外。暂存流程在发布候选目录前校验 CLI 入口、Web 资源、Cordis 配置、生成的 Remote 模块、原生依赖、可执行权限、Node.js 版本和符号链接包含关系。发布时先把原暂存目录重命名为备份；如果候选目录重命名失败，则恢复原目录。

暂存元数据记录源码 commit、锁文件 SHA-256 摘要、Node.js 版本、平台与架构。桌面主进程在打包模式下解析 `process.resourcesPath/sidecar`，在开发模式下解析 `apps/desktop/.stage`；`DSH_DESKTOP_SIDECAR_ROOT` 是唯一显式路径覆盖。两种模式都不会回退到环境中的 Node.js 可执行文件或 checkout 入口。打包冒烟测试必须使用暂存运行时和清理后的环境启动，不依赖 checkout 的 `node_modules`、`PATH` 或 Node.js 安装。

## Delivery phases

P0 在真实桌面窗口中交付既有产品流程：首次模型配置、工作区选择、会话创建和恢复、流式工具输出、审批与用户问题、成果文件打开和下载、干净退出以及再次启动。它不增加托盘、窗口关闭后的后台执行、自动更新、Office 生成、浏览器自动化、云执行或中断外部操作的崩溃安全回放。

下一阶段通过既有插件扩展点增加产品能力，不把业务逻辑写入 Electron：持久化成果文件注册表、Office 文档和表格生成、演示文稿生成、浏览器任务、预览以及任务型入口。这些能力沿用同一套 Web 客户端和 Host sidecar 架构。

## Alternatives considered

**先实现已规划的 Electron IPC 载体。** 这会移除 loopback 监听，但在任何既有流程运行前，都要完整替代 HTTP 路由、WebSocket 事件流、动态 bundle、静态资源和下载。当已鉴权 loopback 载体成为安全或部署限制时，IPC 仍可作为后续加固选项。

**在 Electron 主进程内运行 Harness。** 这会少一个进程，却把 Electron 的 Node ABI、原生模块、故障和关闭顺序与 agent 运行时耦合。独立 sidecar 保留故障隔离，也让打包后的 Host 沿用 CLI 的纯 Node 行为。

**使用 Tauri 和操作系统 WebView。** Tauri 可减小壳体积，但会引入 Rust 和平台 WebView 差异，而当前包图仍需要兼容 Node 的 Host 进程。它没有显著减少首版集成工作，不足以支撑增加第二套运行时工具链。

**分别构建原生用户界面。** 原生 macOS 与 Windows 客户端会重复成熟的 React 客户端并推迟功能对齐。桌面壳的职责是复用该客户端，同时补充进程持有和操作系统集成。

**把 loopback 可达性视为充分保护。** 其他进程和浏览器页面都能访问固定本地端口。Host 与 origin 检查可以防止浏览器混淆，却不能鉴别直接本地调用方，因此桌面部署需要每次启动生成的秘密。

## Acceptance criteria

- 未签名 macOS arm64 应用在未单独安装 Node.js 的机器上启动，并在实测冷启动十秒内进入既有 React 应用。
- 没有精确启动 token 时，每条 HTTP 路由和 WebSocket upgrade 都返回鉴权失败；Electron 只向精确应用 origin 提供该 token。
- 聚焦测试覆盖 BrowserWindow 安全标志、导航规则、外部链接行为、下载行为以及无通用 renderer bridge。
- 第二次启动聚焦已有窗口而不启动另一 Host；关闭与退出后不遗留 sidecar 进程。
- 暂存运行时校验 Node.js 可执行文件、依赖闭包、Web 资源、生成模块、原生模块、文件权限、符号链接、commit 和锁文件摘要。
- 无密钥测试覆盖启动解析、提前退出、超时、重复就绪、优雅关闭、强制终止和打包路径解析。
- 真实打包应用冒烟测试从产物而非源码 checkout 覆盖启动、首次渲染、一条无密钥交互路径、退出和再次启动。
- 相应产物在 Windows 上构建并运行验证前，文档明确标记 Windows 支持尚未验证。

## Risks

如果 Electron 请求标头钩子的 URL 过滤宽于精确 origin，或允许重定向携带已修改标头，bearer token 可能泄露。测试必须覆盖其他主机、端口、scheme 和重定向请求的负例。

通用 Web server 中的鉴权会改变共享载体，必须默认关闭。实现必须在普通路由和 upgrade 路由分发前拒绝请求，使任何插件都无法意外绕过。

复制开发机 Node.js 可执行文件可能产出机器相关的应用。暂存命令必须固定并检查该可执行文件；签名分发前，发布自动化必须改为获取指定平台运行时并校验完整性。

固定端口可能被占用。P0 输出可操作诊断并停止，而不是静默选择其他 origin，因为更改 origin 会使精确标头注入和导航策略失效。

既有 Web 架构 Note 中假设的 IPC 方向仍有价值，但它没有描述首个桌面载体。如果本提案实现，需要同步更新该 Note 与 Web server 子系统文档，把已鉴权 loopback 复用写为当前 Electron 传输，把 IPC 写为延后方案。
