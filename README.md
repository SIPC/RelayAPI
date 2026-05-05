# RelayAPI

## Web 访问密钥

首次启动服务时，RelayAPI 会自动生成一个 `relay_web_...` Web 访问密钥并输出到控制台。访问 Web 管理页面时必须输入这个密钥；验证成功后会写入一个 HTTP-only 会话 Cookie。

密钥明文只在首次生成时显示一次，哈希会保存到 `data/.relay-web-access-key`。如果丢失密钥，可以停止服务、删除该文件后重新启动，系统会生成新的 Web 访问密钥。

也可以通过环境变量 `RELAY_WEB_ACCESS_KEY`（或 `WEB_ACCESS_KEY`）指定固定 Web 访问密钥；设置后不会自动生成密钥文件。

Layered Next.js relay for Codex/OpenAI-compatible traffic.

This implementation uses:

- Next.js App Router route handlers.
- Node 24 built-in `node:sqlite` for SQLite access.
- Two SQLite databases:
  - `data/relay-main.sqlite` for configuration and current operational state.
  - `data/relay-log.sqlite` for request history, usage, health, and audit data.
- Automatic channel routing. There is no frontend-selected “active credential”.

## Requirements

- Node.js `>=24.0.0`
- pnpm

`node:sqlite` is still marked experimental by Node, so build/start output may include Node's experimental warning. The project intentionally uses it to avoid adding native SQLite dependencies.

## Development

```/dev/null/commands.sh#L1-3
pnpm install
pnpm dev
```

Open `http://localhost:3000` for the server-rendered dashboard.

## Storage and secrets

Runtime data is ignored by git:

```/dev/null/tree.txt#L1-4
data/
  relay-main.sqlite
  relay-log.sqlite
  .relay-encryption-key
  .relay-web-access-key
```

Set `RELAY_ENCRYPTION_KEY` or `RELAY_SECRET` in production. If neither is provided, a local `data/.relay-encryption-key` is generated lazily when encrypted Codex tokens are first stored or read.

Useful environment variables:

- `DATA_DIR`
- `RELAY_MAIN_DB_PATH`
- `RELAY_LOG_DB_PATH`
- `CODEX_REDIRECT_URI`
- `CODEX_BASE_URL`
- `CODEX_DEFAULT_MODEL`
- `REQUEST_TIMEOUT_MS`
- `RELAY_ENCRYPTION_KEY`
- `RELAY_WEB_ACCESS_KEY`
- `WEB_ACCESS_KEY`
- `RELAY_IMPORT_LEGACY_CREDENTIALS=1`
- `RELAY_LEGACY_CREDENTIAL_DIRS` using the OS path delimiter

Legacy credential import is opt-in. Put JSON credential files under `data/auths` or configure `RELAY_LEGACY_CREDENTIAL_DIRS`, then set `RELAY_IMPORT_LEGACY_CREDENTIALS=1`.

## Web admin and Admin API quick start

Open `http://localhost:3000` and enter the Web access key. The Web UI stores an HTTP-only `relay_web_session` cookie that protects `/api/admin/*` routes.

To call Admin API routes with curl, first log in and save the Web session cookie:

```/dev/null/commands.sh#L1-5
curl -c relay-web-cookie.txt -X POST http://localhost:3000/api/auth/web-login \
  -H "Content-Type: application/json" \
  -d '{"accessKey":"relay_web_..."}'
```

Create an API key:

```/dev/null/commands.sh#L1-7
curl -b relay-web-cookie.txt -X POST http://localhost:3000/api/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"local key"}'
```

The plaintext key is returned only once. Store it securely. To end the Web session, use the UI logout button or call `POST /api/auth/web-logout`.

Start Codex OAuth in the browser using the demo-compatible HTML flow:

```/dev/null/commands.sh#L1-2
open http://localhost:3000/auth/login
```

The default `CODEX_REDIRECT_URI` is intentionally aligned with `CLIProxyAPI`'s Codex OAuth flow:

```/dev/null/env.txt#L1-1
http://localhost:1455/auth/callback
```

RelayAPI does not need to own port `1455`; copy the final browser callback URL and paste it back into RelayAPI.

You can also start OAuth through JSON:

```/dev/null/commands.sh#L1-2
curl -b relay-web-cookie.txt -X POST http://localhost:3000/api/admin/codex/credentials/oauth/start
```

Open the returned `authUrl`. If your OAuth flow redirects to a local URL that cannot be reached by the server, paste the callback URL back:

```/dev/null/commands.sh#L1-4
curl -b relay-web-cookie.txt -X POST http://localhost:3000/api/admin/codex/credentials/oauth/callback \
  -H "Content-Type: application/json" \
  -d '{"callbackUrl":"http://localhost:1455/auth/callback?code=...&state=..."}'
```

List resources:

```/dev/null/commands.sh#L1-4
curl -b relay-web-cookie.txt http://localhost:3000/api/admin/api-keys
curl -b relay-web-cookie.txt http://localhost:3000/api/admin/codex/credentials
curl -b relay-web-cookie.txt http://localhost:3000/api/admin/channels
```

A default channel is created automatically when a Codex credential is saved. Channels are the routing unit; credentials are only resources bound to channels.

Refresh quota for a credential:

```/dev/null/commands.sh#L1-2
curl -b relay-web-cookie.txt "http://localhost:3000/api/admin/codex/credentials/<credential-id>/quota?refresh=1"
```

## Relay endpoints

External relay endpoints require a bearer API key created through the admin API.

```/dev/null/commands.sh#L1-11
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer relay_sk_..."

curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer relay_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.3-codex","input":"hello"}'

curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer relay_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5(xhigh)","messages":[{"role":"user","content":"hello"}]}'
```

For Codex text models, append `(high)` or `(xhigh)` to the model name to control reasoning effort. The relay strips the suffix before calling upstream and sends `reasoning.effort` accordingly, so `gpt-5.5(xhigh)` is routed as `gpt-5.5` with xhigh thinking. `/v1/models` also exposes these suffixed aliases.

Implemented relay routes:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`
- `POST /api/codex/responses`
- `POST /api/codex/responses/compact`
- `POST /backend-api/codex/responses`
- `POST /backend-api/codex/responses/compact`

## Production checklist

- Run as a single persistent Node.js instance, or ensure only one writer uses the SQLite files.
- Mount a persistent volume for `DATA_DIR` or explicit DB paths.
- Set `RELAY_WEB_ACCESS_KEY` to a strong secret instead of relying on a generated local file.
- Set `RELAY_ENCRYPTION_KEY` or `RELAY_SECRET` before storing Codex credentials.
- Set `CODEX_REDIRECT_URI` to the callback URI used by your OAuth flow.
- Keep the Web admin behind HTTPS so the HTTP-only session cookie is marked secure.
- Do not expose `data/` or environment variables through static hosting or logs.
- Run `pnpm build` before deployment and smoke test login, OAuth, API key creation, channel routing, and logs.

## Checks

```/dev/null/commands.sh#L1-3
pnpm lint
pnpm exec tsc --noEmit --pretty false
pnpm build
```
