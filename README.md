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
- 支持 imge

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
CODEX_USER_AGENT="codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9"
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