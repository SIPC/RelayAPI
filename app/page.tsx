import { cookies } from "next/headers";

import { AdminDashboard } from "@/components/admin-dashboard";
import { WebAccessLogin } from "@/components/auth/web-access-login";
import {
  getAdminOverviewStats,
  queryRequestLogs,
} from "@/src/server/repositories/logs";
import { listApiKeyPublicRecords } from "@/src/server/services/apiKeys";
import { listChannelRecords } from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { getPublicGlobalSettings } from "@/src/server/services/settings";
import { listPublicProxyPoolItems } from "@/src/server/services/proxyPool";
import type { AdminOverviewStats } from "@/src/shared/types/entities";
import {
  initializeWebAccessKey,
  isValidWebSessionValue,
  WEB_SESSION_COOKIE,
} from "@/src/server/services/webAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestLogRow = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_type: string;
  stream: number;
  model: string;
  status_code: number;
  latency_ms: number;
  first_token_latency_ms: number | null;
  api_key_prefix: string | null;
  api_key_name: string | null;
  channel_name: string | null;
  credential_email: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  error_code: string | null;
};

export default async function Home() {
  initializeWebAccessKey();
  const cookieStore = await cookies();
  const webSession = cookieStore.get(WEB_SESSION_COOKIE)?.value;
  if (!isValidWebSessionValue(webSession)) {
    return <WebAccessLogin />;
  }

  // Server Component: read initial public metadata directly from server services
  // so the browser never receives database modules, token envelopes, or key hashes.
  const apiKeys = listApiKeyPublicRecords();
  const codexCredentials = await listPublicCodexCredentials();
  const channels = listChannelRecords();
  const proxyPool = listPublicProxyPoolItems();
  const requestLogs = queryRequestLogs({
    limit: 50,
    offset: 0,
    skipTotal: true,
  });
  const overviewStats = getAdminOverviewStats() as AdminOverviewStats;
  const globalSettings = getPublicGlobalSettings();
  const initialNow = new Date().getTime();

  return (
    <AdminDashboard
      initialApiKeys={apiKeys}
      initialChannels={channels}
      initialCredentials={codexCredentials}
      initialProxyPool={proxyPool}
      initialRequestLogsPage={{
        object: "list",
        data: requestLogs.data as RequestLogRow[],
        limit: requestLogs.limit,
        page: 1,
        offset: requestLogs.offset,
        total: requestLogs.total,
        totalPages: 1,
        summary: {
          errorCount: requestLogs.errorCount,
          totalTokens: requestLogs.totalTokens,
          cachedTokens: requestLogs.cachedTokens,
          cacheHitRate: requestLogs.cacheHitRate,
          avgLatencyMs: requestLogs.avgLatencyMs,
        },
      }}
      initialOverviewStats={overviewStats}
      initialGlobalSettings={globalSettings}
      initialNow={initialNow}
    />
  );
}
