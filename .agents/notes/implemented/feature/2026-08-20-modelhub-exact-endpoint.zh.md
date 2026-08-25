# Agent Note: 可选 ModelHub 提供方插件

Status: implemented

[English](2026-08-20-modelhub-exact-endpoint.md) | 中文

## 问题

内部 ModelHub 在一个固定 POST URL 上提供 OpenAI Chat Completions 请求字段，通过 `ak` 查询参数鉴权，并要求每次请求携带 `X-TT-LOGID`。通用 pi-ai 适配器处理标准协议路径和 Bearer 鉴权。把 ModelHub 传输规则加入该适配器，会为单一部署扩大其公开配置；在 `dsh-base` 中挂载内部路由，则会让每个 profile 都看到这个可选提供方。

## 决策

`@deepseek-ai/dsh-llm-modelhub` 是独立的 LLM Service Provider 插件，同时也是可安装组合包。其 Cordis 插件只在现有 `ctx.llm` 能力上注册 `bytedance-modelhub`，并把提供方无关的消息、工具、回放、附件、超时和流转换委托给公开的 `PiAiAdapter`。ModelHub 的精确目标传输包装层、查询鉴权、请求 id 标头、兼容项、模型目录配置和诊断由该包自行拥有。

组合包 patch 提供内部端点、`AIDP_MODELHUB_AK` 凭据引用，以及最初的 `gpt-5.6-sol` 和 `gpt-5.5-2026-04-24` 纯文本目录。`dsh-base` 保持 `llm-pi-ai` 休眠且不挂载 ModelHub。安装或移除该组合包时，路由、settings namespace 和模型目录作为一个 profile 层一同加入或移除。

插件每次请求通过凭据服务解析 `AIDP_MODELHUB_AK`；未挂载该服务时则通过可信启动环境解析。派发时将密钥加入 `ak`，抑制 Bearer 标头，并在 `X-TT-LOGID` 中加入新的 UUID。配置端点不得包含 URL 用户信息、fragment 或已有 `ak` 参数。pi-ai 将提供方错误转换为 Harness 失败前，插件会清除文本中凭据的原始形式和 URL 编码形式。

插件拥有 `llm-modelhub` settings namespace，并注册一条随包提供的可配置提供方目录记录。Models 页面将此 namespace 识别为直连适配器家族：页面以只写方式存储密钥，在与 DeepSeek 相同的精选折叠区模式中展示精确端点和模型目录，并且不会为该路由标注「自定义」。因此，端点、凭据引用、模型目录、容量回退值、图片上限、空闲超时和重试策略都是可由用户 settings 实时覆盖的组合值。操作会在解析凭据前捕获一个不可变 pi-ai 提供方快照，因此进行中的请求不会混用两代 settings 的事实。

## 考虑过的替代方案

- **向 `llm-pi-ai` 添加 `exactEndpoint`。** 这样可以直接复用其路由配置，但会把一个提供方的精确 URL、查询凭据、跟踪标头和脱敏行为纳入通用适配器的公开约定。独立提供方插件让这些规则留在当前 owner 中，同时仍复用 pi-ai 转换。
- **通过可选组合包配置第二个 `llm-pi-ai` 实例。** 即使活动路由不同，两个实例也会声明相同的 `llm-pi-ai` settings namespace 和已安装提供方目录，从而发生所有权冲突。
- **在 `dsh-base` 中挂载 ModelHub。** 这样不需要安装步骤，但会在每个随发行版提供的 profile 中暴露内部提供方和缺失凭据。组合包机制已经提供可逆的显式启用组合。
- **重新实现 Chat Completions 转换。** 独立协议适配器可以彻底隔离包，但会重复 `PiAiAdapter` 已有的消息、工具、附件、回放、超时和流行为。

## 验证

包测试固定端点校验、模型目录校验、精确请求路径、查询鉴权、无 Bearer 标头、UUID 请求 id、`max_tokens`、凭据脱敏、缺失凭据、图片读取、回放降级、完整与简化 pi-ai 流、路由 dispose 和组合包 manifest。客户端测试固定 ModelHub 字段映射与随包目录元数据。真实 Loader 组合会使用文件 settings 与凭据挂载插件，实时应用重试策略变更，并通过配置的精确端点完成请求。无密钥 headless 快照通过可运行示例启动可选插件，并在持久化会话记录中固定其提供方选择、模型元数据和缺失凭据结果；真实 Web 快照固定直连提供方编辑器、只写凭据处理、精确端点、模型目录以及不出现「自定义」标签的行为。

## 后果

ModelHub 可以按 profile 安装，不改变默认模型目录或通用 pi-ai 配置约定。该包增加一个提供方专用适配器，并依赖 pi-ai 适配器的公开 API；因此 pi-ai 适配器发生破坏性变更时必须协调更新。在另一个消费方证明需要提供方无关扩展之前，通用 `llm-pi-ai` profile 不提供精确端点。

查询凭据会短暂存在于出站 URL 中，ModelHub 基础设施可能看到它。插件避免将凭据存入源码或配置、避免重复 Bearer，并阻止其通过提供方错误文本传播，但无法控制上游 URL 日志。
