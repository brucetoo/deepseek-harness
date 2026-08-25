# @deepseek-ai/dsh-llm-modelhub

[English](README.md) | 中文

可选的 ByteDance ModelHub 模型提供方插件，用于 Harness LLM seam。该包同时是 Cordis 插件和可安装组合包：插件在 `ctx.llm` 上注册固定的 `bytedance-modelhub` 路由，[`cordis.patch.yml`](cordis.patch.yml) 提供内部端点和随包模型目录。`dsh-base` 不挂载该路由。

## 安装

在每个需要暴露 ModelHub 的 profile 中安装组合包：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-llm-modelhub
dsh plugin --profile headless add @deepseek-ai/dsh-llm-modelhub
```

在源码 checkout 中，将包名替换为 `./packages/llm/llm-modelhub`。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-llm-modelhub` 移除该包时，其路由、模型、settings 分节和凭据引用会一起移除。

## 配置

组合包提供以下插件配置项：

```yaml
- id: llm-modelhub
  name: '@deepseek-ai/dsh-llm-modelhub'
  config:
    endpoint: https://aidp.bytedance.net/api/modelhub/online/v2/crawl
    apiKeyEnv: AIDP_MODELHUB_AK
    models:
      - id: gpt-5.6-sol
        name: GPT-5.6 Sol
        input: [text]
      - id: gpt-5.5-2026-04-24
        name: GPT-5.5 (2026-04-24)
        input: [text]
```

`endpoint` 是准确的 POST 目标，插件不会追加 `/chat/completions`。URL 必须是绝对 HTTP(S) 地址，不得包含用户信息、fragment 或 `ak` 查询参数。`apiKeyEnv` 是凭据引用而不是密钥；其默认值为 `AIDP_MODELHUB_AK`，每次请求通过 `ctx.credentials` 解析，未挂载该服务时则通过可信启动环境解析。

`models` 是完整路由目录，必须包含至少一个唯一且非空的 id。每个条目可配置 `name`、`contextWindow`、`maxTokens` 和 `input`；省略 input 时仅支持文本。`defaultContextWindow` 和 `defaultMaxTokens` 填补未声明的容量，默认值分别为 262,144 和 32,768。条目级 `maxTokens` 同时成为该模型的默认请求上限。`streamIdleTimeoutMs` 默认为五分钟，`maxRequestImageBytes` 默认为 20 MiB，省略 `retryPolicy` 时使用共享的 normal 策略并重试五次。

插件拥有 `llm-modelhub` settings namespace，并在 `ctx.llm.listConfigurableProviders()` 中声明路由，因此 Web 模型页面可以存储引用的凭据并在无需重启的情况下覆盖配置。页面将其视为随包提供的直连提供方而非自定义路由：API 密钥是主字段，精确端点与模型目录沿用 DeepSeek 的精选折叠区模式。配置变更从下一次请求生效；进行中的请求保留开始时捕获的端点、模型目录和凭据引用。

## 请求行为

每次请求都会解析凭据，将其加入 `ak` 查询参数，抑制普通 Bearer 标头，并在 `X-TT-LOGID` 中加入新的 UUID。请求使用 pi-ai 的 OpenAI Chat Completions 序列化，并将 ModelHub 兼容项固定为 `supportsStore: false`、`supportsDeveloperRole: false` 和 `maxTokensField: max_tokens`。提供方错误文本会在可能进入会话日志前清除凭据的原始形式和 URL 编码形式。

## 模型体验

### ModelHub 请求

#### 模型看到什么

所选 ModelHub 模型通过 pi-ai 的 Chat Completions 转换接收 Harness 系统提示词、消息历史、工具 schema 和受支持的调用配置。该插件不添加提示词文本。只有配置的 `input` 包含 `image` 且存在 `ctx.attachments` 时，图片内容才可用。

#### Token 影响

精确输入由提供方分词决定。累积 base64 图片载荷超过 `maxRequestImageBytes` 时，pi-ai 转换会用其固定省略文本替换最旧的图片。

#### KV Cache 影响

未变化的组装请求前缀仍可复用提供方缓存。端点、模型、提示词、schema、历史或图片保留决策发生变化时，可能从第一个变化 token 起无法复用。

### ModelHub 响应

#### 模型看到什么

pi-ai 事件会转换为 Harness 的推理、文本、工具调用、用量和结束分片；工具参数在 Harness 日志中保持原始 JSON 字符串。

#### Token 影响

只有 agent loop 保留的响应块会进入后续请求。提供方未单独报告推理 token 时，pi-ai 会将其计入输出用量。

#### KV Cache 影响

已记录的响应块追加到下一次请求，不改变其更早的前缀。查询凭据和请求 id 属于传输元数据，不进入模型上下文。

## 已知限制与延后工作

- **配置目录具有权威性**——精确 POST 目标没有对应的模型列表端点，因此新增模型或变更能力需要更新配置。
- **ModelHub 基础设施仍能看到查询凭据**——插件避免在配置中存储凭据、避免重复发送 Bearer，并阻止提供方错误文本传播凭据，但无法控制上游代理或服务器的 URL 日志。
- **不公开推理控件**——随包目录没有经过验证的 ModelHub 档位映射；在映射得到文档说明前，请求使用端点默认值。
