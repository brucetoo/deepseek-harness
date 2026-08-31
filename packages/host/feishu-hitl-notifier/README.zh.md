# @deepseek-ai/dsh-feishu-hitl-notifier

[English](README.md) | 中文

这是一个可选的 Host 插件。当带 Agent 的 DSH 用户问题进入活动回答 Provider 时，插件会发送一条飞书通知。卡片只跳回 DSH Web，不会回答问题，也不会改变 Provider 的结果。

## 运行要求

部署必须提供以下组件：

- Host PATH 中可用的 `feishu-cli`，或它的绝对可执行文件路径。
- 可工作的 CLI 配置，默认路径是 `~/.feishu-cli/config.yaml`。
- 飞书客户端可以访问的绝对 `http` 或 `https` DSH Web URL。
- 至少一个 `open_id`、`user_id`、`chat_id` 或 `email` 收件人。

预期部署身份为 App ID `cli_a95ed1953aba5bc0`。插件有意不读取或校验该 App ID，而是始终遵循当前 CLI 配置，并且不会读取或记录 App Secret。

## 将插件加入 profile

该包不会进入随产品发布的 bundle patch，因为收件人、CLI 可用性和外部可达 Web URL 都是部署专属信息。请在自己的 profile patch 中加入以下配置：

```yaml
- name: "@deepseek-ai/dsh-feishu-hitl-notifier"
  config:
    enabled: true
    webBaseUrl: "https://dsh.example.com/"
    recipients:
      - type: open_id
        id: ou_operator
      - type: chat_id
        id: oc_oncall
    cli:
      executable: feishu-cli
      configPath: ~/.feishu-cli/config.yaml
      timeoutMs: 10000
    summaryMaxChars: 240
    includeSessionTitle: true
```

## 配置

插件接受以下设置：

- `enabled` 控制是否观察问题。挂载该配置行时，默认值为 `true`。
- `webBaseUrl` 是 DSH Web 的绝对 URL。卡片会把当前会话作为 `session` 查询参数附加到 URL。
- `recipients` 包含互不重复的收件人对象。`type` 为 `open_id`、`user_id`、`chat_id` 或 `email`，`id` 是对应的飞书标识。
- `cli.executable` 指定可执行文件，默认值为 `feishu-cli`。
- `cli.configPath` 指定 CLI 配置，默认值为 `~/.feishu-cli/config.yaml`；插件会在启动子进程前展开 `~`。
- `cli.timeoutMs` 限制单个收件人的发送时长，默认值为 10,000 毫秒。
- `summaryMaxChars` 限制首个问题规范化摘要的长度，默认值为 240 个 Unicode 码点，可设置为 1 到 1,000 的整数。
- `includeSessionTitle` 控制是否在可用时包含当前会话标题，默认值为 `true`。

## DSH Web 设置

浏览器贡献会在 **设置 → 插件 → 插件配置** 下添加 **Feishu HITL notifier**。页面可编辑 `enabled`、`webBaseUrl`、`summaryMaxChars`、`includeSessionTitle` 以及最多 100 个收件人。保存时会用一次带 revision 栅栏的 settings mutation 持久化完整配置；后续通知无需重启 Host 即会使用新配置。这是设置实时应用，不是代码 HMR。

可执行文件、CLI 凭据路径和超时仍由部署管理，永远不会暴露给浏览器。每个已保存收件人都有 **测试** 操作。测试只发送一张固定且保护隐私的卡片，不包含会话、问题、标题或返回链接。新增或修改过的收件人必须先保存才能测试。关闭自动通知后仍可显式测试，但测试依然会发送一条真实飞书消息。

## 通知行为

插件观察 `user-question/requested`。合法请求进入活动 Provider 后，该事件只触发一次。普通问题标记为“问题确认”，带 `plan-review` intent 的问题标记为“计划审核”。插件忽略不带 Agent 的程序化请求，因为这类请求没有可定位的 Web 会话。

每个收件人会通过纯 argv 命令收到一张 `interactive` 卡片：

```text
feishu-cli --config <absolute-path> msg send \
  --receive-id-type <type> --receive-id <id> \
  --msg-type interactive --content <json> --output json
```

卡片只包含交互类型、可选会话标题、有界首问题摘要、问题数（大于一时）和 DSH 链接。它不包含 `detail`、计划正文、完整选项、选项描述、工具参数、会话历史、回答草稿或凭据；日志也不会记录完整收件人 ID。

CLI 解析失败会阻止插件激活。单个收件人的发送失败、非零退出、超时和异常 JSON 输出只会记录日志并被隔离，不能拒绝、取消或延迟原用户问题的回答。

## 模型体验

无，因为该 Host 侧观察者不添加提示词、工具、上下文消息或提供方请求。

#### KV Cache 影响

无；通知卡片不会进入模型输入或 Session 日志。

## 已知限制与暂缓事项

- **没有持久化发送**：发送没有重试、提醒、完成更新或持久化账本；Host 重启可能丢失发送中的通知，CLI 成功退出也不能证明收件人已经阅读卡片。
- **Web URL 必须能从外部访问**：`127.0.0.1` 等 loopback URL 通常无法从手机访问。
