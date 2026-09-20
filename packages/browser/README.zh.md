# browser/：可见公共网页浏览器能力

[English](README.md) | 中文

此系列为无需凭据的公共 HTTP(S) 页面提供一个限定所有者范围的可见浏览器，并把提供方无关的生命周期、桌面 Electron 实现和面向模型且受审批约束的工具分开。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`browser/`](browser/README.zh.md) | 定义浏览器所有权、观察结果、预备操作和共享错误 | `ctx.browser` |
| [`browser-playwright-electron/`](browser-playwright-electron/README.zh.md) | 通过 loopback CDP 和 Playwright 运行临时 Electron 浏览器 | 提供 `ctx.browser` |
| [`tool-browser/`](tool-browser/README.zh.md) | 提供七个带一次性审批的公共网页浏览器工具 | 注册到 `ctx.tools` |

[桌面公共网页浏览器 Agent Note](../../.agents/notes/implemented/feature/2026-09-16-desktop-public-browser-automation.zh.md)负责安全模型、生命周期与暂缓的已认证浏览器工作。
