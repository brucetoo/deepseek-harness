# @deepseek-ai/dsh-browser

[English](README.md) | 中文

一个通过 `ctx.browser` 暴露可见临时浏览器的提供方无关 Service Definition。服务把每次操作绑定到确切的所有者 `Agent`，要求提供方串行执行调用，并用 URL、标题和 ARIA 快照表示页面。

## API

`BrowserRuntime` 定义 `open`、`snapshot`、`prepare`、`commit`、`release`、`wait` 与 `close`。元素变更使用两阶段操作：`prepare` 保留一个确切的无障碍元素，并返回不透明的 `BrowserPreparedActionId` 及其可观察指纹；审批后，`commit` 再次检查并仅操作该保留元素一次。`release` 在拒绝或取消时释放预备状态，不执行操作。

`parsePublicBrowserUrl` 只接受不含凭据的绝对 HTTP(S) URL。`BrowserError` 携带稳定的共享及提供方专用 `BROWSER_*` 错误码。

## 模型体验

通过 `@deepseek-ai/dsh-tool-browser` 间接影响；该 Consumer 负责 schema、审批文本、提示词指导、输出限制和渲染。

#### KV Cache 影响

不会直接导致失效；模型请求变化由 Consumer 负责。

## 已知限制与暂缓事项

- 接口有意不提供已认证 profile、标签页、任意脚本、坐标、截图、上传、下载和弹窗控制。
- 预备指纹覆盖可观察的元素身份，但不能证明脚本安装的 handler 在审批与提交之间保持不变。
