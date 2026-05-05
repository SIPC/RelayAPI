import { startOAuthLoginSession } from "@/src/server/services/codexCredentials";
import { isWebRequestAuthenticated } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Demo-compatible OAuth entry. The generated URL intentionally uses the same
// default redirect path as RelayAPI-demo: /auth/callback.
export async function GET(request: Request) {
  if (!isWebRequestAuthenticated(request)) {
    return Response.redirect(new URL("/", request.url), 303);
  }

  const session = startOAuthLoginSession();
  return new Response(renderOAuthLogin(session), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderOAuthLogin(session: {
  authUrl: string;
  redirectUri: string;
  state: string;
}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex OAuth 登录</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #09090b; color: #f4f4f5; }
    main { max-width: 760px; margin: 0 auto; padding: 48px 20px; }
    section { border: 1px solid #27272a; background: #18181b; border-radius: 24px; padding: 28px; }
    a.button { display: inline-block; margin-top: 20px; padding: 12px 18px; border-radius: 999px; color: #052e16; background: #86efac; font-weight: 700; text-decoration: none; }
    code, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    code { word-break: break-all; color: #a7f3d0; }
    textarea { width: 100%; min-height: 96px; margin-top: 12px; border-radius: 12px; border: 1px solid #3f3f46; background: #09090b; color: #f4f4f5; padding: 12px; }
    button { margin-top: 12px; padding: 10px 14px; border-radius: 999px; border: 0; background: #3b82f6; color: white; font-weight: 700; }
    p { line-height: 1.7; color: #d4d4d8; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Codex OAuth 登录</h1>
      <p>这个页面使用 CLIProxyAPI 同款 Codex OAuth 流程：后端只生成链接并保存 PKCE state，用户把最终 callback URL 粘贴回来完成 token exchange。</p>
      <p>生成链接中的 <code>redirect_uri</code> 为：</p>
      <p><code>${escapeHtml(session.redirectUri)}</code></p>
      <a class="button" href="${escapeHtml(session.authUrl)}">打开 Codex OAuth</a>
      <p>登录后请复制浏览器最终跳转到的完整本地 callback URL，并粘贴到下面。</p>
      <form method="post" action="/auth/callback-input">
        <textarea name="callback_url" placeholder="http://localhost:1455/auth/callback?code=...&state=..."></textarea>
        <button type="submit">提交 callback URL</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
