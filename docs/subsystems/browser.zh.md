# 浏览器自动化

[English](browser.md) | 中文

浏览器自动化 seam 控制一个用于无需凭据的公共 HTTP(S) 页面的可见临时浏览器。它拆分为 Service Definition（[`dsh-browser`](../../packages/browser/browser)）、桌面 Provider（[`dsh-browser-playwright-electron`](../../packages/browser/browser-playwright-electron)）和面向模型的 Consumer（[`dsh-tool-browser`](../../packages/browser/tool-browser)）。该能力是可选项，只会由提供 Electron 可执行文件、应用入口和临时 profile 根目录的桌面组合挂载。

源码：[`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## 所有权与生命周期

每次操作都携带确切的所有者 `Agent`；其他 Session 会收到 `BROWSER_BUSY` 或 `BROWSER_FOREIGN_OWNER`，无法观察或操作页面。`open` 分配 worker 与私有 profile；`close`、取消、Agent dispose、Provider dispose 和 worker 故障都会汇入须等待的驱动、进程树与 profile 清理流程，完全清理后才释放所有权。

## 请求与观察结果

| 类型 | 字段与含义 |
|---|---|
| `BrowserOpenRequest` | `url`：不含凭据的绝对 HTTP(S) 目标 |
| `BrowserWaitRequest` | `durationMs`：正整数 Provider 等待时长 |
| `BrowserObservation` | 最终顶层 `url`、文档 `title` 与限制深度的 ARIA `snapshot` |
| `BrowserElementTarget` | 确切的无障碍 `role`、确切的无障碍 `name` 与可选的零起始 `index` |
| `BrowserElementAction` | 封闭的 `click`、`fill` 或 `select` 请求联合类型 |

`parsePublicBrowserUrl` 会规范化支持的 URL，并以 `BROWSER_INVALID_URL` 拒绝格式错误、非 HTTP(S) 或包含凭据的输入。`BrowserError` 使用开放字符串错误码，因此 Provider 可以提供专用错误。

## 预备操作

元素变更使用 `prepare` → 审批 → `commit`。`prepare` 保留确切的元素句柄，并返回 `BrowserPreparedAction`，其中包含不透明的 `BrowserPreparedActionId`、当前页面 URL、原始操作和可观察的 `BrowserElementFingerprint`。`commit` 检查同一个已挂载句柄及其指纹，执行一次后消费该 id；`release` 不执行操作并释放它。这样可以防止审批被转移到重新匹配的元素，但无法检测未改变可观察指纹的脚本 handler 变更。

## 桌面策略

Electron worker 允许打开的 origin 及后续同源顶层导航。预备链接或表单目标可以允许一个经检查的跨源目标；其他顶层 origin 会被阻止，并通过有关联标识的私有 worker 协议报告。权限、子窗口、下载、webview、非 Web 顶层 URL 和密码填写均以拒绝方式结束。跨源子资源仍可用，且 loopback CDP 端点不做认证，因此该实现不能作为鉴权载体。

[桌面公共网页浏览器 Agent Note](../../.agents/notes/implemented/feature/2026-09-16-desktop-public-browser-automation.zh.md)记录了安全取舍与未采用方案。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime-abstract-seam"></a>

### `ctx.browser` — `BrowserRuntime` (abstract seam)

One visible ephemeral browser owned by an exact live Agent and therefore by its Session. Implementations serialize calls and release ownership only after complete worker and profile cleanup.

```ts cordis-catalog
/**
 * Open a new ephemeral browser after the Consumer obtains approval.
 * @param owner - Exact Agent whose Session owns the browser.
 * @param request - Canonical credential-free HTTP(S) target.
 * @param signal - Cancellation of launch and navigation.
 * @returns Current rendered page observation.
 */
abstract open( owner: Agent, request: BrowserOpenRequest, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Observe the current page without changing it.
 * @param owner - Exact owning Agent.
 * @param signal - Cancellation of snapshot collection.
 * @returns Current rendered page observation.
 */
abstract snapshot(owner: Agent, signal?: AbortSignal): Promise<BrowserObservation>

/**
 * Resolve and retain one exact element without acting on it.
 * @param owner - Exact owning Agent.
 * @param action - Accessible target and requested mutation.
 * @param signal - Cancellation of element resolution.
 * @returns Prepared identity and approval-visible fingerprint.
 */
abstract prepare( owner: Agent, action: BrowserElementAction, signal?: AbortSignal, ): Promise<BrowserPreparedAction>

/**
 * Recheck and commit a previously prepared element action exactly once.
 * @param owner - Exact owning Agent.
 * @param id - Provider-issued prepared action identity.
 * @param signal - Cancellation of action and resulting observation.
 * @returns Current rendered page observation.
 */
abstract commit( owner: Agent, id: BrowserPreparedActionId, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Release one prepared action without executing it. Implementations make
 * repeated release harmless so every fail-closed path can converge here.
 * @param owner - Exact owning Agent.
 * @param id - Provider-issued prepared action identity.
 */
abstract release(owner: Agent, id: BrowserPreparedActionId): Promise<void>

/**
 * Wait for a bounded interval, then observe the current page.
 * @param owner - Exact owning Agent.
 * @param request - Duration selected by the Consumer within its configured cap.
 * @param signal - Cancellation of the wait.
 * @returns Current rendered page observation.
 */
abstract wait( owner: Agent, request: BrowserWaitRequest, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Close the owner's browser and await worker and profile quiescence.
 * @param owner - Exact owning Agent.
 */
abstract close(owner: Agent): Promise<void>
```

Types: [Agent](core.zh.md)

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
