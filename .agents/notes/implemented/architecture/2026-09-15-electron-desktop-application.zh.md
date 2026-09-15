# Agent Note: 使用已鉴权本地 Host 的 Electron 桌面应用

Status: implemented

[English](2026-09-15-electron-desktop-application.md) | 中文

## Problem

DeepSeek Harness 需要一个可安装的桌面应用，复用既有 Host 与 React 客户端，且不要求单独安装 Node.js 运行时。应用必须阻止无关本地调用方访问固定的 loopback Host，持有其进程生命周期，把桌面状态与用户的 CLI 安装隔离，并打包 Web 组合选中的完整运行时。

GUI 架构曾为 Electron IPC 载体预留位置，但先实现它会重复建设 HTTP 路由、WebSocket 流、动态插件 bundle、静态资源和下载，桌面应用才能运行既有产品流程。源码启动还可以解析 workspace 链接、生成模块、原生依赖和环境中的可执行文件，而已安装应用不能假定这些条件存在。

## Decision

`apps/desktop` 是一个 Electron 应用，包含一个加固的 `BrowserWindow` 和一个独立的纯 Node Host sidecar。已交付的开发产物以未签名的 macOS arm64 为目标。Windows 软件包通过对等的运行时与应用验证前，不提供 Windows 支持。

sidecar 使用暂存的 `dsh web` 入口在 `127.0.0.1:37615` 上运行，并禁用浏览器自动打开。每次启动都会创建一个 256 位 bearer token，并通过专用环境变量传入。当可选的 `bearerTokenEnv` 配置存在时，`dsh-host-webserver` 会在路由选择前要求每个 HTTP 请求和 WebSocket upgrade 携带精确的 `Authorization: Bearer <token>`。普通浏览器部署只有在配置该字段时才启用鉴权。

Electron session 只为精确的应用 HTTP 与 WebSocket origin 注入该标头。窗口禁用 Node 集成，启用上下文隔离与 Chromium 沙箱，不暴露通用 preload bridge，拒绝新窗口，并阻止离开本地应用 origin 的导航。明确的外部 HTTP 与 HTTPS 链接通过操作系统打开。

应用在启动 Host 前获取单实例锁。第二次启动会聚焦现有窗口。关闭最后一个窗口后，Electron 会先执行有界的 sidecar 关闭流程，再退出。启动与关闭故障使用不含 token 的分类诊断。桌面状态使用 Electron 的 `userData/dsh` 目录，因此打包应用不会加载用户的 CLI profile 或 `$DSH_HOME`。

## Packaged runtime

`apps/desktop-runtime` 是显式的 pnpm 部署根目录，列出 Web 组合需要的全部直接运行时依赖与对等依赖（peer dependency）。`desktop:stage` 构建 Host 包与 Web 资源，创建将 workspace 包注入为文件的生产部署，复制当前 Node 可执行文件，并校验必要文件、Cordis 配置、生成的 Remote 模块、原生模块导入、可执行权限、Node 版本、符号链接包含关系，以及不依赖 checkout 的 CLI 冒烟测试。

每个候选版本记录源码 commit、锁文件 SHA-256 摘要、Node 版本、平台与架构。经过校验的候选版本会移动到 `.stage/versions/<id>`，随后由原子文件 `.stage/current` 选择供新的开发启动与打包使用的版本。已经运行的实例继续持有自己的不可变版本目录。

打包模式解析 `process.resourcesPath/sidecar`；开发模式解析 `.stage/current` 选中的版本。`DSH_DESKTOP_SIDECAR_ROOT` 是唯一显式路径覆盖。两种模式都不会回退到环境中的 Node 可执行文件或 checkout 入口。Electron Builder 把选中的暂存版本放在 ASAR 外，并通过固定版本的本地 Electron 发行包生成未签名的 arm64 应用 bundle 与 ZIP 压缩包。

## Verification

聚焦测试覆盖 bearer 鉴权、精确 origin 标头注入、导航策略、单实例行为、启动诊断、关闭升级、不可变暂存版本发布、闭包校验、打包配置和打包路径解析。暂存校验会加载 `node-pty` 与 `koffi`，并在清理后的环境中调用暂存 CLI。

真实打包应用冒烟测试从 `.app` 启动，等待 React 界面就绪，关闭首次运行通知，通过鼠标事件打开 Settings，捕获已渲染窗口，经 Electron 浏览器生命周期退出，校验退出码为零和 sidecar 进程数量，并使用同一桌面数据目录再次启动。

## Alternatives considered

**先实现 Electron IPC 载体。** 这会移除 loopback 监听，但必须替换所有既有 Web 传输行为。当已鉴权 loopback 成为安全或部署限制时，IPC 仍可作为加固选项。

**在 Electron 主进程内运行 Harness。** 这会少一个进程，却把 Electron 的 Node ABI、原生模块、故障和关闭顺序与 agent 运行时耦合。sidecar 保留故障隔离和 CLI 的纯 Node 执行模型。

**使用 Tauri 和操作系统 WebView。** 这会增加 Rust 与平台 WebView 差异，而当前包图仍需要兼容 Node 的 Host 进程。

**分别构建原生用户界面。** 原生客户端会重复既有 React 客户端并推迟产品对齐。桌面壳复用该客户端并增加操作系统集成。

**把 loopback 可达性视为鉴权。** 其他本地进程可以直接调用固定端口。Host 与 origin 检查不能鉴别这类调用方，因此桌面部署需要每次启动生成的秘密。

## Consequences

桌面应用无需第二套传输实现，即可运行与浏览器应用相同的路由、流、bundle、资源和下载。代价是固定本地端口、应用专用 bearer 层、打包的 Node 运行时，以及明显大于系统 WebView 壳的产物体积。

macOS 产物未签名，也未经过 notarization（公证）。打包流程会在校验平台、架构和版本后复制构建机器的 Node 可执行文件；签名分发需要获取目标平台运行时并校验完整性。更新、托盘行为、最后一个窗口关闭后的后台执行、Office 生成、浏览器自动化和云执行仍是独立产品能力，应通过插件实现，而不是写入 Electron 主进程逻辑。
