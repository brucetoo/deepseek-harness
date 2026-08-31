# Agent Note: Feishu notifications for user questions

Status: implemented

[English](2026-08-27-feishu-hitl-notifications.md) | 中文

## Problem

当操作者离开 DSH 浏览器时，Web Agent 可能长期停在 `ask_user_question` 或 `exit_plan_mode`。现有 Composer 是权威回答界面，但无法通过飞书提醒操作者。替换该界面或注册第二个用户问题 Provider 会拆分回答权，并违反服务的单 Provider 约束。

## Decision

`@deepseek-ai/dsh-user-questions` 在合法请求进入活动 Provider 后发送一次受控的 `user-question/requested` 观察事件。Provider Promise 仍是权威结果；观察者工作并行且受控，不能回答、取消、拒绝或延迟该 Promise。

可选 Host 插件 `@deepseek-ai/dsh-feishu-hitl-notifier` 观察带 Agent 的请求，识别 `plan-review` intent，构造有界纯文本卡片，并通过 `ctx.subprocess` 调用本机 `feishu-cli`。插件向每个配置的 `open_id`、`user_id` 或 `chat_id` 发送一张交互卡片。卡片按钮跳转到携带 `?session=<id>` 的绝对 DSH URL；Client runtime 在用首份 Session 列表验证该 id 后，把它作为启动选择覆盖值。

CLI 从显式解析后的 `~/.feishu-cli/config.yaml` 读取凭据。预期部署使用 App ID `cli_a95ed1953aba5bc0`，但插件不读取或校验该 ID，也永远不读取 App Secret。插件不经过 Shell，而是把 JSON 卡片作为一个 argv 值传入。CLI 非零退出、超时和异常输出只记日志，日志不包含 CLI stderr 或收件人标识；这些失败不进入模型上下文，也不拒绝原问题。插件卸载时先停止观察，再取消所有进行中的发送，并等待它们结束后完成 teardown。

DSH CLI 可以解析和安装该包，但发布的 bundle patch 不默认挂载它。部署需要在自己的 profile patch 中选择启用，因为收件人、可访问的 Web URL 和本机 CLI 都属于部署配置。

## Settings 扩展

Host settings 命名空间、实时重配置和测试 remote 已在该功能分支上实现。浏览器卡片源码也已经存在，但在部署完成 Client 贡献的打包和挂载前，本 Note 不把该 UI 视为已经交付。

插件拥有一个 Host settings 命名空间，并公开一个原子 `configuration` 值，而不是多个相互独立的 settings 键。其顶层字段为 `enabled`、`webBaseUrl`、`recipients`、整数 `summaryMaxChars`（默认值为 `240`）和布尔值 `includeSessionTitle`（默认值为 `true`）。`webBaseUrl` 必须是不超过 2,048 个 Unicode 码点的 HTTP(S) 绝对 URL，且不能包含用户信息、查询参数或片段。`summaryMaxChars` 必须在 `1` 到 `1000` 之间。`recipients` 最多接受 100 个互不重复的条目；每项都有去除首尾空白后长度为 1 到 512 个 Unicode 码点的 `id`，`type` 为 `open_id`、`user_id`、`chat_id` 或 `email`。启用配置时至少需要一个收件人；禁用配置时可以持久化空列表。由 profile 管理的 `cli.executable`、`cli.configPath` 和 `cli.timeoutMs` 位于该命名空间之外，因此浏览器 settings 无法重定向或调整承载本机凭据的进程边界。

保存时针对完整 `configuration` 执行一次带 revision 栅栏的 settings 操作，不按字段逐个发起 mutation。settings-file Provider 持久化接受的值，插件无需重启 Host，就会把它实时应用到之后的观察事件。这属于运行时配置替换，不是代码 HMR。校验失败、持久化失败或 revision 冲突都会保留完整草稿，并显示经过清理的失败信息以供修正；表单绝不会只应用一部分。

每次观察问题和每次测试都在开始工作前捕获一个不可变的有效配置快照。之后的保存只影响后续工作，因此一次发送不会混用旧收件人与新 URL 或内容策略。插件仍是单个 Host 实例：只有一个命名空间所有者、一个生成的 Typert remote 和一个观察者。评审否决了多个可配置实例，因为它们会让命名空间所有权和事件扇出变得含糊。

Client 贡献以插件自有命名空间为键注册在 `settings.plugin.item` 下，而不是把通知插件知识加入 Settings shell。当前源码使用带标签的原生控件、键盘可达的操作、alert 和实时状态语义，并在新增收件人后放置焦点；收件人状态用文本表达，而不是只靠颜色。该界面的交付要求 Client 产物与生成的 Typert remote 产物随 Host 插件一起提供。

## 测试通知约定

每个收件人的 **测试** 操作只把已保存 `configuration` 中某个收件人的身份传给生成的 Typert remote。它不接受任意目标或草稿收件人，Host 会从自己的不可变已保存快照中再次解析目标。未保存的收件人编辑必须先保存，才能测试。

测试发送固定且保护隐私的卡片，并明确说明这是 DSH 飞书通知测试。卡片不包含问题文本、会话标题、会话链接、transcript、草稿、工具参数、凭据或收件人标识。remote 只返回封闭且经过清理的 `sent`、`busy`、`not-configured` 或 `delivery-failed` 状态；原始 CLI 输出、stderr、路径、凭据和收件人标识绝不跨越该边界。自动通知关闭时仍可测试已保存的收件人，但 UI 必须明确警告：该测试由用户手动触发，并不会启用自动发送。

测试复用现有的单次纯 argv 发送路径及其配置的超时。它不增加重试、提醒、发送账本或已读回执；成功状态仍只表示本机 CLI 接受了发送操作。

## Request observation contract

`user-question/requested` 是进程内、非持久化的观察通知，携带已经校验的 `AskUserQuestionRequest`。一次服务 `ask()` 最多通知一次，时点是 Provider 同步接受调用之后。浏览器重连重放不会再次产生事件。该事件不是待处理请求注册表、发送审计或回答通道。

通知插件忽略无 Agent 请求，因为它们没有可跳转的 Web 会话。消息只包含首个问题文本、问题数量、可用的当前会话标题和会话链接；绝不发送 `detail`、选项描述、工具参数、会话历史或回答草稿。

## Alternatives considered

**观察 API Proxy 的 `question/requested` 帧。** 这会让 Host 通知插件耦合到单一传输 Provider，并且无法服务其他用户问题 Provider。

**注册第二个 `UserQuestionProvider`。** 服务有意只允许一个回答所有者。通知接收器不是回答 Provider，不能与 Web UI 竞争。

**直接使用飞书 OpenAPI SDK。** 这会重复用户指定的本机 `feishu-cli` 已经负责的认证和令牌管理。

**默认挂载到 Web bundle。** 默认行会让本机 CLI 可用性和私有收件人成为产品启动条件。该能力属于部署选项，因此保持 opt-in。

**在 Settings 中公开 profile CLI 字段。** 这会让浏览器用户能够重定向可执行文件或凭据配置的解析位置。这些字段继续由部署管理，并排除在命名空间之外。

**分别持久化和实时应用每个浏览器字段。** 这可能产生混合配置代际和部分保存。一次原子 `configuration` mutation 让持久化、校验与运行时替换共享同一边界。

**让测试面向草稿或任意收件人。** 这会把诊断操作变成通用消息发送界面，并绕过对已保存配置的检查。测试只在 Host 上解析一个已保存收件人，并使用固定内容。

**为测试增加重试或发送账本。** 这会改变观察者的尽力而为架构，并引入持久发送语义。测试发送与自动发送保持相同的单次尝试约定。

## Verification

- User-question 测试固定了合法 Provider 入口后只产生一次受控事件，且准入失败不产生事件。
- 通知插件测试固定了纯 argv 用户／群发送、计划正文与选项描述排除、发送失败与异常输出隔离，以及卸载时的取消和等待。
- 真实 Loader 测试组合部署 YAML 形态，调用 `ctx.userQuestions.ask()`，并观察生成的 `feishu-cli` argv。
- Client runtime 测试固定了 `?session=<id>` 启动选择与无参数回退行为。
- Host 测试固定了原子 settings 注册、校验限制、禁用时的空收件人、每次操作的不可变快照、实时更新、固定测试内容和四种封闭 remote 状态。
- Client 源码测试固定了单次操作的 revision 栅栏、冲突或失败时保留草稿、只能测试已保存收件人、禁用警告，以及以键注册的 `settings.plugin.item` 贡献。
- 包包含 invariant companion、双语文档、生成目录、Host 项目引用和 CLI 运行时依赖闭包。

## Consequences

该设计保留唯一的 DSH 权威回答界面，同时为操作者提供外部提醒和可用的返回链接。发送仍是进程内能力，没有重试、提醒、完成更新或持久化账本。Host 重启可能丢失发送中的通知，CLI 成功退出也不能证明收件人已经阅读卡片。不校验 App ID 而跟随 CLI 当前配置，意味着修改该文件会切换发送机器人。配置的 DSH URL 必须能从飞书客户端访问；手机中的 loopback URL 指向手机本身，而不是 Host。
