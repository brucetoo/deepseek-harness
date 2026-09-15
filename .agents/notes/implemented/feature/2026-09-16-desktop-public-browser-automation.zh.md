# Agent Note: 桌面端公开网页浏览器自动化

Status: implemented

[English](2026-09-16-desktop-public-browser-automation.md) | 中文

## Problem

桌面应用可以通过[内置 `browser-research` 工作流](../../implemented/feature/2026-09-15-desktop-bundled-workflows.zh.md)搜索和抓取公开网页，但不能操作渲染后的页面。因此，即使用户能够看到页面并手动完成交互，需要跟随控件、填写普通表单值、选择选项或检查结果页面的任务仍会停在调研阶段。

加入浏览器控制还会引入 HTTP 获取所不具备的权限。受控页面可能包含私密文本、运行脚本、联系其他 origin、提交会改变状态的请求并保留凭据。浏览器观察结果会成为模型可见的工具结果，因此进入持久 Session 日志。首个实现必须提供有用的交互，同时不能声称具备尚无法防护的安全鉴权、任意浏览器控制或持久化能力。

## Decision

桌面组合包含一个浏览器能力 seam，并由三个独立归属的角色组成：

- `@deepseek-ai/dsh-browser` 定义浏览器运行时、类型化操作、所有者身份、预备动作生命周期、页面观察结果和错误分类。
- `@deepseek-ai/dsh-browser-playwright-electron` 通过 Playwright 和桌面应用已经携带的 Electron 可执行文件提供运行时。
- `@deepseek-ai/dsh-tool-browser` 提供模型可见的浏览器工具、审批请求、输出上限、提示词指引和工具展示。

桌面 sidecar 会传入明确的 Electron 可执行文件、应用入口和临时数据根目录路径。仅当这些值存在时，条件式 Host 与 Agent-Preset 配置项才挂载提供方和消费方；普通 CLI、Web、headless 与 SDK 组合不公开浏览器工具。

工具集为 `browser_open`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_select`、`browser_wait` 和 `browser_close`。模型提供的目标使用可访问角色、可访问名称和可选索引。CSS、XPath、坐标、任意 JavaScript、标签页、截图、上传、下载和弹窗控制均不提供。

## Execution model

提供方固定使用 `playwright-core`，并通过其公开的 `chromium.connectOverCDP` API 建立连接。它通过 `ctx.subprocess` 以专用 browser-worker 模式启动打包的 Electron 可执行文件；worker 把 Chromium 调试接口绑定到 `127.0.0.1` 上由操作系统分配的端口，并创建一个可见且经过加固的 `BrowserWindow`。提供方解析有界的就绪输出、建立连接，且不发布稳定端点。

同一时刻只有一个 DSH Session 持有浏览器。打开浏览器时会创建使用私有临时 profile 的新 worker。其他 Session 会收到 `BROWSER_BUSY`，直至所有者关闭可见浏览器，且进程树清理达到完全停稳。浏览器状态不会在 Session 或应用启动之间传递：cookie、local storage、IndexedDB、缓存、Service Worker 和 HTTP 鉴权数据都会随临时 profile 消失。

每次成功打开页面或执行动作都会返回当前 URL、标题和 ARIA 快照。快照使用配置的 Playwright 深度与超时，随后由消费方限制完整 UTF-8 工具结果并标记截断。模型必须遵循「观察一次、执行一个动作、再次观察」的循环，不能连续依赖未经验证的页面状态假设。

## Authorization and target identity

`browser_open`、`browser_click`、`browser_fill` 和 `browser_select` 会在提交前请求一次性审批。只有精确结果 `allowed-once` 才允许执行。拒绝、取消、不可用、格式错误的回答、策略 `never`、超时或提供方故障都会释放全部预备状态，且不执行浏览器动作。

审批文本会指出当前 URL 与确切目标，并包含静态可见的链接或表单目标、所选选项或完整填写值。密码控件会在审批前被拒绝。审批文本还会说明所提供的值与后续页面观察结果会进入 Session 历史。

对于元素动作，提供方会在审批前解析一个确切元素，并记录其可观察的标签、类型、可访问身份、链接目标和表单目标。提交前必须再次确认同一元素仍然挂载且指纹匹配。Playwright 的可访问定位器必须仍包含该保留元素，因此角色、文本、ARIA 名称或关联标签变化都会导致失败，且不会改为操作替代元素。脚本安装的行为仍可能在可观察指纹不变时发生变化，这是明确保留的风险。

## Navigation and lifecycle

worker 只允许不含凭据的 HTTP 与 HTTPS 顶层 URL。`browser_open` 允许其精确 origin 以及同源重定向。预备的点击或表单动作可以仅为该次动作允许已检查的跨源目标；所有其他跨源顶层导航都会被阻止，并报告尝试访问的 URL 以及当前页面是否仍可使用。页面仍可加载跨源子资源，因为普通公开网页依赖这些资源。

提供方会等待 worker 确认导航许可后才发送 CDP 动作。动作成功或失败时都会撤销未使用的许可，并等待撤销确认后才返回。撤销失败会终止 worker，避免留下可以复用的许可。

窗口禁用 Node 集成，启用上下文隔离与 Chromium 沙箱，拒绝权限请求、子窗口、下载与文件选择器上传，并拒绝非 Web 顶层导航。该浏览器不是鉴权载体：内置 skill 会在打开浏览器前拒绝需要登录、秘密、私有页面、上传、下载、弹窗、截图或不受支持的视觉／坐标交互的任务。

提供方调用会串行执行。审批等待使用工具执行信号。`browser_close`、可见窗口关闭、`agent/disposed`、消费方 dispose、提供方 dispose、取消、启动失败以及渲染器或 worker 崩溃都会汇入清理流程。驱动清理带有截止时间，并与进程树终止同时进行。只有进程树退出且临时 profile 删除后才释放所有权；这些资源消失后，驱动断连不能继续占用所有权。关闭超时会保留所有权，之后进程树退出时会继续清理。浏览器动作绝不会自动重试。

## Verification

包测试覆盖 URL 校验、所有权、繁忙状态、每种审批结果、确切预备元素身份、指纹漂移、密码拒绝、输出上限、取消、worker 退出恢复和拆卸。桌面 worker 测试固定 origin 策略、命令语法、私有 profile 选择和事件编码。Loader 测试启动三包组合并验证注册。

无密钥 ACP snapshot 使用确定性的浏览器 Provider 通过真实 Agent、Session、工具、审批、持久化和协议路径运行。它的 transcript 保留三次 `allowed-once` 决策、公共填写值、提交结果、显式关闭，以及七工具 schema 和提示词指导。

无密钥 Electron 兼容性测试会启动实际的 worker 与 Playwright 版本，打开确定性的本地表单，按无障碍目标填写和点击控件，观察结果，验证未经审批的跨源脚本导航会报告 `BROWSER_NAVIGATION_BLOCKED`，随后再次取得快照、关闭浏览器并确认 profile 已删除。原生 Windows 打包仍是 Windows 产物可以声称已验证之前的发布门禁。

本实现通过了 119 项浏览器包测试及逐文件 100% 覆盖率、157 项桌面端、打包与工作区约束定向测试、无密钥 ACP snapshot、真实 Electron 兼容性测试、全部 13 项 hygiene 检查和桌面 stage。macOS 发布演练生成了 `DeepSeek-Harness-0.1.1-rc.2-arm64.zip`，其 SHA-256 为 `e74ac2f2afe0ecdbc25fa2dbef85edb188d252be24178b5799df6e5efac5e7a2`；校验和验证与打包应用 smoke 测试确认了 React 就绪、sidecar 启停、包内许可和身份检查、worker 退出时的终止顺序，以及 sidecar 端口释放。

## Alternatives considered

**打包 Playwright Chromium。** 这符合 Playwright 的主要浏览器路径，但 Electron 已携带兼容的 Chromium 运行时；再加入一个大型浏览器载荷会新增下载、完整性校验、缓存和平台发布责任。

**挂载 Playwright MCP 或 agent CLI。** 这些产品提供广泛的浏览器工具，但会绕过本仓库的审批审计、规范工具结果、Session 日志、UI 展示和包生命周期，并且仍需单独分发浏览器。

**直接驱动 Electron `webContents` 与 DOM。** 这会自行实现 Playwright 已维护的定位器解析、可操作性判断、等待、可访问性快照和取消行为。

**复用持久浏览器 profile。** 复用登录状态会减少操作摩擦，但也会让后续 Session 继承此前的 cookie 与存储状态，使 profile 锁和崩溃恢复更复杂，并扩大临时 CDP 监听器的影响范围。鉴权能力需要单独设计。

**把自定义可执行文件交给 Playwright 的实验性 Electron launcher。** 其自定义可执行文件路径不会注入 Playwright 的 Electron loader，因此采用该路径会依赖私有启动协议，而不是已公开的 CDP 客户端。

## Consequences

临时 CDP 监听器未鉴权；在浏览器任务运行期间，发现其随机端口的同一用户进程可以连接。首个仅限公开页面的实现接受这一项本地威胁；在没有更强控制通道的情况下，鉴权浏览不能通过该传输交付。

ARIA 提取可能在消费方应用字节上限之前消耗内存，而基于可访问角色／名称的定位无法操作画布、无标签控件或仅依赖视觉的界面。动态事件处理器可能在审批后发生变化，同时不改变已记录的元素指纹。跨源子资源可以联系公开或私有网络服务。这些约束必须作为明确的产品限制保留，不能将其描述为完整浏览器自动化。

桌面应用获得了实用的可见公共网页交互，同时不会在 Session 之间继承浏览器身份或凭据。每次变更都需要一次性审批，每次成功观察都会在 Session 历史中增加有界但依赖页面数据的内容。取消导航可能留下仍可操作但文档为空的页面，因此模型必须检查返回状态，不能假定先前页面仍完整保留。
