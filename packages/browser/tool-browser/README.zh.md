# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

[`ctx.browser`](../browser/README.zh.md) 能力的面向模型 Consumer。它注册七个工具，负责一次性审批文本、限制完整 UTF-8 观察结果、贡献仅限公共网页的操作指导，并且不导入具体浏览器 Provider。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `browser_open` | `url` | 审批并打开一个不含凭据的 HTTP(S) 页面 |
| `browser_snapshot` | 无 | 返回当前 URL、标题和 ARIA 快照 |
| `browser_click` | 无障碍 role/name 与可选 index | 预备、审批并点击一个保留元素 |
| `browser_fill` | target 加完整 `value` | 预备、审批并替换普通控件的值 |
| `browser_select` | target 加可见 `option` | 预备、审批并选择一个选项 |
| `browser_wait` | `duration_ms` | 在部署上限内等待，然后观察 |
| `browser_close` | 无 | 关闭浏览器并释放其临时 profile |

只有确切的 `allowed-once` 审批结果会执行 `browser_open`、`browser_click`、`browser_fill` 或 `browser_select`。其他所有结果都以拒绝方式结束；被拒绝的预备元素会被释放，不执行操作。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxOutputBytes` | `64000` | 完整 UTF-8 观察结果上限 |
| `timeoutMs` | `30000` | 协作式工具调用预算 |
| `maxWaitMs` | `10000` | `browser_wait` 接受的最长时长 |

## 模型体验

### 系统提示词

#### 模型看到的内容

固定指导如下：

##### 公共网页浏览器指导

```markdown
Use browser_* tools only for public pages that need visible interaction. Do not use them for login, credentials, secrets, private pages, uploads, downloads, popups, screenshots, or coordinate-based interaction. Observe, perform one approved action, then observe again. Always call browser_close when the browser task ends.
```

#### Token 影响

插件挂载期间固定指导始终存在。每次成功观察都会增加有界的 URL、标题、截断状态与 ARIA 内容；审批中可见的值和后续工具结果会保留在 Session 历史中。

#### KV Cache 影响

插件注册与指导不变时前缀稳定。工具调用、审批和结果追加在可复用前缀之后。

### 工具 schema

#### 模型看到的内容

模型会看到生成的[七个浏览器工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-browser)。目标使用确切的无障碍 role/name 对与可选的零起始 index；不存在 selector、脚本、坐标、凭据或文件参数。

#### Token 影响

配置与注册不变时 schema 成本固定。依赖数据的结果由 `maxOutputBytes` 限制。

#### KV Cache 影响

七个定义保持可见时前缀稳定；限定范围或插件生命周期变化可能从首个变化的 schema token 起使复用失效。

## 已知限制与暂缓事项

- 本 Consumer 仅支持无需凭据的公共网页交互。登录、secret、私有页面、上传、下载、弹窗、截图、标签页和视觉坐标均被有意拒绝或未提供。
- 审批每次只覆盖一个操作，不提供持久站点授权。
- 输出截断会保持 UTF-8 完整，但可能省略更深层的 ARIA 状态；模型必须导航或缩小页面范围，不能假设隐藏内容。
