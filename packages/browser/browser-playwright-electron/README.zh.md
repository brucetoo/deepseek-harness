# @deepseek-ai/dsh-browser-playwright-electron

[English](README.md) | 中文

[`@deepseek-ai/dsh-browser`](../browser/README.zh.md) 的桌面 Service Provider。它以专用 worker 模式启动打包的 Electron 可执行文件，从有界启动输出中发现随机 loopback CDP 端点，并把 `playwright-core` 连接到 worker 的唯一页面。

## 运行时

每次 `open` 都会创建私有临时 Chromium profile 和一个可见的加固窗口。worker 拒绝权限、下载、通过 webview 上传、子窗口、非 Web 导航和未获允许的顶层来源。带关联标识的 stdin/stdout 协议会确认许可的安装与撤销，并报告被阻止的目标。已批准动作结束时会撤销未使用的许可；撤销失败会关闭 worker。执行动作前，保留的元素必须仍匹配已批准的可访问角色／名称和 DOM 指纹。

Provider dispose、Agent dispose、取消、显式关闭、worker 退出和启动失败都会汇入清理流程。驱动清理有截止时间，不能延迟 worker 终止。所有权会保留到进程树退出且 profile 删除，包括关闭超时后子进程才退出的情况。驱动清理错误仍会报告，但进程和 profile 清理成功后不会继续占用所有权。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `electronExecutable` | 必填 | 打包的 Electron 可执行文件路径 |
| `applicationEntry` | 必填 | 传给 Electron 的桌面应用入口 |
| `tempRoot` | 必填 | 临时浏览器 profile 的父目录 |
| `launchTimeoutMs` | `10000` | worker 就绪截止时间 |
| `operationTimeoutMs` | `10000` | Playwright 与 worker 协议截止时间 |
| `navigationSettleMs` | `50` | 操作完成后检查导航策略前的稳定时段 |
| `cleanupTimeoutMs` | `5000` | 驱动清理与进程树完全停稳截止时间 |
| `processGraceMs` | `2000` | worker 终止宽限期 |
| `readinessMaxBytes` | `16384` | 启动输出与协议行上限 |
| `snapshotDepth` | `8` | ARIA 快照最大深度 |

## 模型体验

通过 `@deepseek-ai/dsh-tool-browser` 间接影响；本 Provider 返回 URL、标题和 ARIA 状态，但不注册提示词或工具 schema。

#### KV Cache 影响

不会直接导致失效；模型请求变化由 Consumer 负责。

## 已知限制与暂缓事项

- CDP 在随机 loopback 端口上不做认证，因此同一 OS 用户下的其他进程可能在任务运行期间附加。
- ARIA 快照无法表示仅使用 canvas 或缺少标签的界面；取消顶层导航后，页面可能仍可操作但文档为空。
- Provider 使用 Electron 内置的 Chromium，而非单独固定版本的 Playwright 浏览器，因此升级 Electron 或 Playwright 时必须运行真实兼容性冒烟测试。
