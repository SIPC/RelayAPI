# RelayAPI

RelayAPI - 一站式管理你的 Codex OAuth

[快速开始](#快速开始) | [Web 访问密钥](#web-访问密钥) | [管理后台](#web-管理后台) | [LinuxDO](https://linux.do/)

---

![Dashboard](img/dashboard.png)
![Channels](img/channel.png)
![OAuth](img/oauth.png)

---

## 项目简介

RelayAPI 是一个基于 Next.js App Router 的分层中继服务，用于管理 Codex / OpenAI-compatible 请求流量、API Key、Codex 凭据、渠道路由、请求日志与用量状态。

项目特性：

- 支持 OpenAI-compatible  接口。
- 支持 Codex / Claude OAuth 凭据接入与配额刷新。
- 支持 OpenAI-compatible / Anthropic 上游 API Key、独立加密凭据及多 Key 调度。
- 支持客户端 Relay API Key 管理与 Web 管理后台。
- 支持自动渠道路由，无需前端选择“当前凭据”。
- 使用双 SQLite 数据库存储配置、运行状态、日志、审计与用量数据。
- 使用 Node.js 24 内置 `node:sqlite`，避免额外 native SQLite 依赖。
- 支持通过 Codex OAuth 直连原生 Images 接口，兼容 GPT Image 2 / 2.5 / 2.6 的生成与编辑；实际模型权限取决于上游。

## 普通对话

普通 OAuth 对话请求以 CPA `8289ec4c` 的默认逻辑为对照：

- `POST /v1/chat/completions`、`POST /v1/responses`：支持 Codex 和 Claude 模型；普通 HTTP 请求使用 HTTP 上游，按调用方选择返回 JSON 或 SSE，省略 `stream` 时返回 JSON。
- `POST /v1/messages`、`POST /v1/messages/count_tokens`：提供原生 Claude Messages 和 token 计数接口，支持 Bearer 或 `x-api-key` 形式的 Relay API Key。Claude Code 也可直接使用 Codex 模型：与 CPA 一致，Messages 转换为 Codex Responses（system 转 developer 消息，长工具名和调用 ID 缩短后在响应中还原，thinking 预算映射为 reasoning effort，只回放 Codex 签发的 reasoning 签名，同一 Claude Code 会话复用一个 prompt cache），token 计数用 o200k 分词器在本地计算。Codex 渠道开启 Responses 能力即可承载这两个接口。
- Codex 保留显式 `parallel_tool_calls`、`prompt_cache_key`、`service_tier`；支持 `fast` 转 `priority` 和 `ultrafast`，路由提示头与最终请求体一致。Chat 未指定思考摘要时不默认请求摘要。省略模型时默认使用 `gpt-6.1-sol`，环境变量 `CODEX_DEFAULT_MODEL` 可覆盖。
- Claude OAuth 保留调用方系统提示原文，并按模型选择系统提示的位置、思考等级或预算；设备标识持久化到凭据，对话标识在请求体和请求头中保持一致。
- Claude OAuth 请求支持 `anthropic/` 前缀及 Opus / Sonnet / Haiku 的点分版本号，例如 `anthropic/claude-opus-5-5`、`anthropic/claude-opus-5.5` 均发送为 `claude-opus-5-5`，也可附加 `(1m)`、`(high)` 等现有后缀。渠道和 Relay Key 白名单推荐配置规范名 `claude-opus-5-5`；别名不绕过授权。API Key 渠道仍使用配置中的精确模型名，不自动去前缀或改版本号。
- Claude 普通转换请求采用最近可缓存消息的断点；OAuth 订阅主线程用 1h TTL，账号处于额外付费用量（overage，由最近一次响应的 `anthropic-ratelimit-unified-*` 头判断，未知按非 overage）时与 Claude Code 一样退回 5m，调用方显式写的 TTL 保留；显式缓存模式保留调用方设置。通过原生客户端识别后保留其系统提示和缓存布局，并重绑定所选上游凭据的账户和设备身份。
- 默认客户端标识：Codex 与 CPA 一致（`codex-tui/0.154.0`）；Claude Code 取官方 `2.1.332`（UA、`cc_version`、stainless 包 `0.128.0`，CPA 内置的是 `2.1.321`），运行时版本 `v26.3.0` 未能从官方二进制静态核实，仍保持原值。已有凭据、数据库设置或环境变量中的自定义 User-Agent 仍优先。

回归验证使用临时数据库、合成凭据和本机模拟上游：`pnpm test`。实际账号可用性需要部署后验证。

### 对话响应中的账号额度

以上对话接口在 JSON 和 SSE 响应头中返回本次所选上游账号的额度快照，正文格式保持兼容。例如：

```http
X-Relay-Quota-Provider: codex
X-Relay-Quota-Source: upstream
X-Relay-Quota-Observed-At: 2026-10-24T12:00:00.000Z
X-Relay-Quota-Age-Seconds: 0
X-Relay-Quota-5h-Used-Percent: 25
X-Relay-Quota-5h-Remaining-Percent: 75
X-Relay-Quota-5h-Reset-At: 2026-10-24T13:00:00.000Z
X-Relay-Quota-7d-Remaining-Percent: 60
```

`Provider` 为 `codex`、`claude`、`openai` 或 `anthropic`。`Source` 为 `upstream`（本次上游响应头）、`cache`（同账号 5 分钟内的缓存）或 `unavailable`（没有可用额度数据）。缓存优先使用当前进程收到的额度，Codex 也可读取管理台刷新后已有的额度缓存；缓存超过 5 分钟或窗口已重置时不再返回该窗口。未知数值省略，不会填成 0。请求数、Token 限流等其他窗口以各自名称返回 `Limit` / `Remaining` 等字段；它们与账号 5 小时、7 天的使用比例分别表示。

可用的原生 `x-codex-*` / `anthropic-ratelimit-*` 额度头也会保留，浏览器可通过 CORS 暴露头读取。不会返回邮箱、账号 ID 或凭据。每次对话不额外发送额度探测请求。SSE 响应头发送后无法更新，因此这是收到上游响应头时的快照，不保证包含本次对话结束后的消耗；普通客户端是否显示额度取决于其是否读取这些响应头。

## 上游 API Key 接入

上游 API Key 与客户端使用的 `relay_sk_*` 是两种不同凭据：客户端继续使用 Relay Key，服务端按授权渠道选择 OAuth 或供应商 Key。原有 Codex / Claude OAuth 通道保留，API Key 不参与 OAuth 刷新，也不注入 CLI 身份或账户标识；Anthropic API Key 渠道与 OAuth 共用默认缓存断点（调用方没写任何断点才补，上限 4 个），但 TTL 保持默认 5m，调用方显式写 1h 才发 `extended-cache-ttl`。

### 配置步骤

1. 在管理台“凭据”的“上游 API Key 凭据”中新增 OpenAI-compatible 或 Anthropic Key。Key 使用 AES-256-GCM 加密保存，管理接口只返回脱敏前缀；编辑时留空表示保留原 Key。可选择直连、全局代理或代理池。
2. 新建对应 API 渠道，绑定一个或多个同类型凭据，配置模型白名单、接口能力及 Base URL。API 渠道默认关闭，保存配置后需显式启用。优先级、权重、健康度和凭据冷却机制与现有通道共用。
3. 编辑客户端 Relay API Key，**在渠道白名单中显式勾选这个 API 渠道**。空渠道白名单仍只允许 OAuth，不会自动获得付费 API 渠道权限。请求使用模型白名单中的精确模型名。

| 渠道 | 默认 API 根地址 | 支持的下游接口 |
| --- | --- | --- |
| OpenAI-compatible API Key | `https://api.openai.com/v1` | Chat Completions、Responses、Images 生成/编辑（按渠道能力配置） |
| Anthropic API Key | `https://api.anthropic.com/v1` | Messages、token count；Messages 能力也可转换 Chat Completions / Responses |

自定义 Base URL 应包含供应商的版本或网关前缀，执行器只追加接口路径。例如 `https://gateway.example/prefix/v1` 的 Chat 请求会发送至 `/prefix/v1/chat/completions`。不接受 URL 内嵌用户名/密码、查询参数或 fragment；不跟随上游重定向，避免 Key 被发送到其他地址。自定义上游将接收该渠道请求内容和 Key，请仅配置可信服务。

### 协议与费用边界

- OpenAI 同协议请求保留原始 JSON 参数和扩展字段，不经过 Codex Responses 转换；图片编辑 multipart 保留文件、多图、重复字段及遮罩，不转为 Codex data URL JSON。
- Anthropic 原生 Messages 保留调用方对话、system 文本、工具名、thinking 及缓存设置，使用渠道配置的 base URL、`x-api-key` 和 `anthropic-version`；不透传客户端身份头，并去掉 `metadata.user_id`、`diagnostics` 与 Claude Code 计费块。`anthropic-beta` 由 Relay 按发送的 body 生成：body 用到的功能（如 `output_config.format`、advisor 工具、逐轮 effort、1h 缓存）自动带上对应 beta，调用方声明的 thinking/上下文类 beta 在可用时保留，`claude-code-*`、`oauth-*`、`redact-thinking`、`afk-mode` 及未知 beta 不发送；Chat / Responses 转换请求 body 里的 `betas` 移到请求头。token count 不强制添加 `max_tokens`，不按流式请求发送；返回的估算 Token 数保留在响应中，不计入本地每日 Token 消耗。
- Chat / Responses 转 Anthropic 复用现有协议转换器，但不进行 Claude Code 工具改名或 OAuth 身份注入。转换能力仍以现有转换器和上游模型为准。
- API 渠道的模型名兼容 `openai/`、`anthropic/`、`google/` 前缀：`openai/gpt-5.4` 与 `gpt-5.4` 视为同一模型（不同厂商前缀不互通），发给上游的是渠道白名单里配置的写法，因此 OpenRouter 等以 `openai/gpt-5.4` 配置的渠道仍收到带前缀的名称；其他命名空间（如 `meta-llama/`）按原样精确匹配。
- API 渠道必须配置非空模型白名单。不会自动附加 OAuth 思考后缀、映射到旧模型，或认为 Codex 目录中的 `gpt-image-2.6-*` 必然可被官方 API Key 调用。`GET /v1/models` 会补入客户端显式授权且启用的 API 渠道模型；仅绑定 API 渠道的客户端不会继承 OAuth 订阅模型目录。
- 请求先选渠道，再按协议转发。上游 401、429 或其他失败不会自动尝试其他凭据，也不会回退到 OAuth；混合渠道的首次选择仍由显式授权、能力、模型、优先级和权重决定。
- usage 从实际 JSON / SSE 结果提取并写入本地统计，返回的请求/Token 限流头不代表账户余额。API Key 不自动进行生成探测；连接测试、真实可用性及费用应由账号持有人确认。

升级会自动迁移数据库并保留现有凭据及渠道绑定，建议先备份 `data` 卷。API Key 接入回归使用临时数据库、合成 Key 和本机 mock 上游，不验证真实账号权限；可运行 `node --test tests/upstream-*.test.mjs`。

## Antigravity OAuth

Antigravity 是仅承接 **Gemini 系列**的独立渠道，提供 `POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages` 和 `POST /v1/messages/count_tokens`。支持 JSON、SSE、完整对话历史以及函数和自定义文本工具。后续工具轮次须回传原始 output items，包括带 `encrypted_content` 的 reasoning item（Messages 中为 thinking 块的 signature）。渠道只接受 `gemini-*` 模型 ID；客户端也可使用 `google/gemini-*` 前缀。即使上游账号目录或旧渠道白名单含有 Claude、GPT-OSS 等模型，也不会展示为 AGY 可用模型或路由到 AGY。

1. Relay 与 CLIProxyAPI 一样内置 Antigravity 桌面客户端的 OAuth client ID 和 secret，无需额外配置；`RELAY_ANTIGRAVITY_OAUTH_CLIENT_ID`、`RELAY_ANTIGRAVITY_OAUTH_CLIENT_SECRET`、`RELAY_ANTIGRAVITY_OAUTH_SCOPE` 仅用于覆盖默认值。授权不使用 PKCE，没有项目的账号会通过 `onboardUser` 自动开通。
2. 回调地址默认为 `http://localhost:51121/oauth-callback`。已有注册回调时，设置 `RELAY_ANTIGRAVITY_OAUTH_REDIRECT_URI`。在管理台连接 Google 账号，授权后将浏览器回调 URL 粘贴回 Relay。
3. 新建 Antigravity 渠道并绑定账号；模型白名单留空时按账号目录中的 Gemini 模型路由。客户端拿 Relay Key 调用上述接口。凭据可手动续期，续期同时刷新账号的可用模型目录；进入到期前五分钟时，请求也会触发续期。升级前保存的非 Gemini 白名单项在路由时被忽略，修改白名单时须删除这些项；仅绑定 AGY 的 Key 请求非 Gemini 模型会返回 503，不会发给 Google。
4. 账号卡片的额度与 CPA 管理面板同源，读取 `retrieveUserQuotaSummary` 的模型分组周额度和 5 小时额度；daily 端点只返回部分分组时继续查询其他端点并合并。

Gemini 请求沿用 CPA 的转换方式：携带 Antigravity 客户端 User-Agent、`requestId` 与稳定的 `sessionId`，清理工具和响应 schema。429 会按 Google 的错误原因和重试时间处理：短时限流原地重试，其余为该账号的该模型设置冷却并切换到下一个账号。不再提供 AGY 的 Claude/GPT-OSS 转发或 Claude Google One AI 积分回退。

本地回归使用模拟的 Google 授权、项目发现和推理响应，可运行 `node --test tests/antigravity-route.test.mjs`。真实账户需要 Google 接受所配置的 OAuth 客户端，并为账户返回有效的 Antigravity 项目。Google 的个人计划条款限制第三方应用使用 Antigravity OAuth。 [Antigravity 条款](https://antigravity.google/terms)

## 图片生成与编辑

`POST /v1/images/generations` 和 `POST /v1/images/edits` 接受以下请求模型 ID，`GET /v1/models` 也会返回这些 ID；这不代表 Codex 订阅上游实际提供了这些图片模型：

- `gpt-image-2`（省略 `model` 时的默认值）
- `gpt-image-2.5`
- `gpt-image-2.5-sunburst`
- `gpt-image-2.5-flare`
- `gpt-image-2.5-sunburst-2026-09-08`
- `gpt-image-2.5-flare-2026-09-08`
- `gpt-image-2.6`
- `gpt-image-2.6-sunburst`
- `gpt-image-2.6-flare`

GPT Image 2.5 的 `quality` 支持 `auto`、`low`、`medium`、`high`、`xhigh`、`max`。`gpt-image-2.5`、`gpt-image-2.6` 裸名及不带日期的 Sunburst / Flare 名称均直接发送给上游，不会在本地固定到日期版本、其他变体或旧版模型。`quality`、`size` 等业务参数继续透传，2.6 的参数范围和账号权限以实际上游为准。图片编辑支持 JSON 的 `images[].image_url` / `images[].file_id`、同类 `mask` 引用和 multipart 文件上传，两个接口均支持 `stream: true`。

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer YOUR_RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2.6-sunburst","prompt":"一只坐在窗边的橘猫","quality":"auto","size":"1024x1024"}'
```

图片接口采用 CPA 的非 SIWC Codex 直连方式：复用渠道的 Codex OAuth access token、账号标识和代理，使用配置中的 Codex User-Agent，通过 HTTP 请求渠道地址加 `/images/generations` 或 `/images/edits`。默认渠道地址为 `https://chatgpt.com/backend-api/codex`，图片模型放在顶层 `model`；上传文件和遮罩会转换为 JSON data URL。即使凭据配置为 WebSocket，图片接口也使用 HTTP。

此路径不经过 Responses 图片工具，不使用 Sol / Astra 主模型；API Key 和渠道白名单应允许请求的图片模型 ID。原生 JSON / SSE 图片结果及上游元数据会保留；`response_format: "url"` 会把 base64 图片转换为 data URL。若上游明确报告了不同的图片模型，返回 `image_model_mismatch`；若上游未返回模型标识，则不能仅凭请求 ID 确认实际模型。原生接口失败时不会回退到 Responses。RelayAPI 目前仍拒绝 Free 凭据的图片请求。

此前通过 Responses 图片工具指定 2.5 时，实测返回的工具模型为 `gpt-image-2-codex`；该结果只说明旧路径的行为。2026-10-24，原生直连的 Sunburst / Flare 两个 2.5 请求 ID 均已实测返回有效 PNG，但上游未提供实际模型标识，因此未独立确认后台模型版本。新增的 2.5 裸名及 2.6 系列沿用原生直连协议，仅通过隔离回归验证，尚未使用真实账号验证。部署时需在 API Key 和渠道的非空模型白名单中放行新 ID。

模型 ID 与参数参考 [OpenAI 官方图片生成文档](https://developers.openai.com/api/docs/guides/tools-image-generation)。本地回归验证：`pnpm test:images`。

## 环境要求

- Node.js `>=24.0.0`
- pnpm

> `node:sqlite` 在 Node.js 中仍标记为 experimental，因此构建或启动时可能会看到实验性功能提示，这是预期行为。

## 快速开始

```yaml
services:
  relay-api:
    image: sipcink/relay-api:latest
    container_name: relay-api
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      HOSTNAME: 0.0.0.0
      DATA_DIR: /app/data
    volumes:
      - relay-api-data:/app/data

volumes:
  relay-api-data:
    name: relay-api-data
```

## Web 访问密钥

首次启动服务时，RelayAPI 会自动生成一个 `relay_web_...` Web 访问密钥，并在首次启动日志中输出。使用 Docker Compose 部署时，可以通过以下命令查看：

```bash
docker logs relay-api
```

访问 Web 管理页面时必须输入该密钥；验证成功后，系统会写入 HTTP-only 会话 Cookie。

密钥明文只会在首次生成时显示一次，哈希会保存到：

```text
data/.relay-web-access-key
```

如果密钥丢失，可以停止服务，删除该文件后重新启动，系统会生成新的 Web 访问密钥。

也可以通过环境变量指定固定 Web 访问密钥：

```env
RELAY_WEB_ACCESS_KEY=relay_web_...
# 或
WEB_ACCESS_KEY=relay_web_...
```

设置后不会自动生成密钥文件。

## Codex User-Agent

发往 Codex 上游接口和额度刷新接口的 `User-Agent` 可在 Web 管理台的“全局设置”中配置，也可在单个 Codex 凭据的设置弹窗中单独覆盖。

生效优先级：凭据覆盖值 → 管理台全局设置 → `CODEX_USER_AGENT` 环境变量 → 内置默认值。

```env
CODEX_USER_AGENT="codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)"
```

清除管理台全局设置后，会回退到环境变量或内置默认值；清除凭据覆盖后，会使用当前全局 User-Agent。


## CC Switch 的 Codex 上游额度查询

`GET /v1/usage` 使用 `Authorization: Bearer <Relay Key>`，返回该 Key **明确绑定的通道所绑定的、已启用的 Codex OAuth 凭据**的 WHAM 额度。每份凭据分别提供 5 小时和每周窗口，不相加、不平均，不代表下一次请求一定选中的账号，也不是 Relay Key 的每日 Token 余额。

### 配置步骤

1. 在 Relay 管理台的 Codex 通道中绑定要展示的 OAuth 凭据。只看一个账号时，使用专用的单凭据通道；池模式可绑定多个凭据。
2. 在 Relay API Key 的通道白名单里**明确勾选上述通道**。绑定即允许持有该 Key 的人查看这些凭据的账号整体额度；不另设开关。空通道白名单虽然可用于 OAuth 生成，但此查询返回空列表，不公开整个账号池。禁用通道/凭据、移除绑定立即撤回可见范围，Key 和通道的模型白名单无交集时也不展示；临时冷却的凭据仍列出并标记 `cooldown`。
3. 在 CC Switch 中选择 **Codex → Relay 第三方供应商卡片 ⋯ → 配置用量查询 → 启用 → 自定义**，不要选择 Sub2API 或官方订阅模板。
4. 完整复制 [自定义用量脚本](docs/cc-switch-usage.js) 到脚本框。API Key 和 Base URL 继承供应商配置；使用的是 **Relay Key，不是 Web 管理密钥或 OAuth token**。脚本内保留 `{{apiKey}}`、`{{baseUrl}}` 占位符，不填写真实密钥。Base URL 可以以 `/v1` 结尾，也可为根地址，支持网关路径前缀。
5. 刷新间隔建议 **5 分钟**。点击“测试脚本”，成功后保存。两份凭据应得到四条记录，每条显示独立的剩余百分比、重置时间及快照时间；CC Switch 可能将这些条目称为“多个套餐”。

### 返回与保鲜约定

- JSON 的 `schema` 为 `relay.codex-quota.v1`，`selection` 为 `bound_channels`，`credentials[]` 每项包含 Key 范围内稳定的脱敏 `ref`、自动生成的 `label`、`routingState`、`cache` 和 `windows[]`。不会使用邮箱或私密备注作为名称，也不返回 OAuth token、邮箱、account_id、内部凭据 ID、raw、proxy 或上游错误正文。
- 窗口 `id` 为 `5h` / `7d`，提供 `usedPercent`、`remainingPercent`、ISO `resetAt` 和 `state`；只展示上游确认时长的主窗口，非标准时长不冒充 5h/周。未知值为 `null`，不是 0。旧版缓存没有时长信息时会尝试受控刷新，刷新前不展示未经确认的百分比。
- 凭据级复用现有 `codex_quota_cache`，2 分钟内为 `fresh`。到期/冷缓存请求会有限等待刷新（单次 WHAM 最长 8 秒），不使用请求结束后可能丢失的后台任务。同凭据 single-flight，所有 Key 和管理员刷新共享 SQLite 租约；共享同一主数据库的多个 worker 合计最多并发 4 次，超出时先返回快照或 `missing`，后续轮询继续补齐。独立数据库的部署不共享限频。
- 刷新失败保留最后成功快照，按 30 秒、60 秒、120 秒等指数退避，最长 15 分钟，并遵守更长的 `Retry-After`。退避状态和租约持久化，进程重启不清空退避；崩溃租约到期后可恢复。管理员手动刷新也不绕过成功后的 2 分钟间隔或失败退避。
- `cache.state` 为 `fresh` / `stale` / `expired` / `missing`，`cache.retrievedAt` 为实际 WHAM 快照时间，`ageSeconds` 为年龄。超过 10 分钟隐藏全部旧百分比；某窗口重置时间已过时单独标记 `reset_pending` 并隐藏该窗口百分比，不推定已恢复满额。另一个未重置的窗口仍可展示。
- `force`、`refresh`、`raw`、`credentialId` 等查询参数均不改变行为或权限。每次响应均 `Cache-Control: no-store`。缺失/无效 Key 返回 401，禁用/到期 Key 返回 403；有效 Key 无可见凭据返回 200 和空列表。Key 每日 Token 已耗尽或上游窗口已耗尽仍返回 200；生成接口原有额度限制不变。
- 脚本逐个返回数值有效的窗口，部分未知时在说明中标明遗漏数量，全部未知时提示稍后重试/检查绑定。CC Switch 可能保留上次成功结果，请以每行的**快照时间**判断新鲜度；重置时间是说明文字，不承诺自动倒计时。

WHAM 是上游账号整体额度，包含其他 Key、设备和官方客户端的消耗，不是这把 Relay Key 独占的额度或精确剩余 Token 数。此接口只服务 CC Switch 自定义用量查询，**不实现 Codex CLI 原生 `/status`**。CC Switch 自定义脚本由桌面端后端请求，不需要额外开放浏览器 CORS。

本地回归：`node --test tests/usage-route.test.mjs`（临时 SQLite、合成凭据、模拟 WHAM，同时执行完整脚本）。脚本契约基于 CC Switch 4.0.37 的实现；实际安装版本的桌面展示和真实账号额度应在获准部署后联调。

## Star History

<a href="https://www.star-history.com/?repos=SIPC%2FRelayAPI&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&legend=top-left" />
 </picture>
</a>
