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
- 支持 Codex OAuth 凭据接入与配额刷新。
- 支持 API Key 管理与 Web 管理后台。
- 支持自动渠道路由，无需前端选择“当前凭据”。
- 使用双 SQLite 数据库存储配置、运行状态、日志、审计与用量数据。
- 使用 Node.js 24 内置 `node:sqlite`，避免额外 native SQLite 依赖。
- 支持通过 Codex OAuth 直连原生 Images 接口，兼容 GPT Image 2 / 2.5 的生成与编辑；实际模型权限取决于上游。

## 普通对话

普通 OAuth 对话请求以 CPA `8289ec4c` 的默认逻辑为对照：

- `POST /v1/chat/completions`、`POST /v1/responses`：支持 Codex 和 Claude 模型；普通 HTTP 请求使用 HTTP 上游，按调用方选择返回 JSON 或 SSE，省略 `stream` 时返回 JSON。
- `POST /v1/messages`、`POST /v1/messages/count_tokens`：提供原生 Claude Messages 和 token 计数接口，支持 Bearer 或 `x-api-key` 形式的 Relay API Key。
- Codex 保留显式 `parallel_tool_calls`、`prompt_cache_key`、`service_tier`；支持 `fast` 转 `priority` 和 `ultrafast`，路由提示头与最终请求体一致。Chat 未指定思考摘要时不默认请求摘要。省略模型时默认使用 `gpt-6.1-sol`，环境变量 `CODEX_DEFAULT_MODEL` 可覆盖。
- Claude OAuth 保留调用方系统提示原文，并按模型选择系统提示的位置、思考等级或预算；设备标识持久化到凭据，对话标识在请求体和请求头中保持一致。
- Claude 普通转换请求采用最近可缓存消息的断点及 OAuth 1h TTL；显式缓存模式保留调用方设置。通过原生客户端识别后保留其系统提示和缓存布局，并重绑定所选上游凭据的账户和设备身份。
- 默认客户端标识与上述 CPA 版本一致：Codex `codex-tui/0.154.0`、Claude Code `2.1.280` / SDK `0.112.1`。已有凭据、数据库设置或环境变量中的自定义 User-Agent 仍优先。

回归验证使用临时数据库、合成凭据和本机模拟上游：`pnpm test`。实际账号可用性需要部署后验证。

## 图片生成与编辑

`POST /v1/images/generations` 和 `POST /v1/images/edits` 接受以下请求模型 ID，`GET /v1/models` 也会返回这些 ID；这不代表 Codex 订阅上游实际提供了这些图片模型：

- `gpt-image-2`（省略 `model` 时的默认值）
- `gpt-image-2.5-sunburst`
- `gpt-image-2.5-flare`
- `gpt-image-2.5-sunburst-2026-09-08`
- `gpt-image-2.5-flare-2026-09-08`

GPT Image 2.5 的 `quality` 支持 `auto`、`low`、`medium`、`high`、`xhigh`、`max`。不带日期的 Sunburst / Flare 名称作为上游别名直接发送，不会在本地固定到 `2026-09-08`。图片编辑支持 JSON 的 `images[].image_url` / `images[].file_id`、同类 `mask` 引用和 multipart 文件上传，两个接口均支持 `stream: true`。

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer YOUR_RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2.5-sunburst","prompt":"一只坐在窗边的橘猫","quality":"max","size":"1024x1024"}'
```

图片接口采用 CPA 的非 SIWC Codex 直连方式：复用渠道的 Codex OAuth access token、账号标识和代理，使用配置中的 Codex User-Agent，通过 HTTP 请求渠道地址加 `/images/generations` 或 `/images/edits`。默认渠道地址为 `https://chatgpt.com/backend-api/codex`，图片模型放在顶层 `model`；上传文件和遮罩会转换为 JSON data URL。即使凭据配置为 WebSocket，图片接口也使用 HTTP。

此路径不经过 Responses 图片工具，不使用 Sol / Astra 主模型；API Key 和渠道白名单应允许请求的图片模型 ID。原生 JSON / SSE 图片结果及上游元数据会保留；`response_format: "url"` 会把 base64 图片转换为 data URL。若上游明确报告了不同的图片模型，返回 `image_model_mismatch`；若上游未返回模型标识，则不能仅凭请求 ID 确认实际模型。原生接口失败时不会回退到 Responses。RelayAPI 目前仍拒绝 Free 凭据的图片请求。

此前通过 Responses 图片工具指定 2.5 时，实测返回的工具模型为 `gpt-image-2-codex`；该结果只说明旧路径的行为。2026-10-24，原生直连的 Sunburst / Flare 两个 2.5 请求 ID 均已实测返回有效 PNG，但上游未提供实际模型标识，因此未独立确认后台模型版本。本次普通对话改造通过隔离回归，部署后的账号可用性仍需验证。

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


## Star History

<a href="https://www.star-history.com/?repos=SIPC%2FRelayAPI&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=SIPC/RelayAPI&type=date&legend=top-left" />
 </picture>
</a>
