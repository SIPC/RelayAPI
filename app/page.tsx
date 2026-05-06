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
  api_key_prefix: string | null;
  api_key_name: string | null;
  channel_name: string | null;
  credential_email: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
  const requestLogs = queryRequestLogs({ limit: 50, offset: 0 });
  const overviewStats = getAdminOverviewStats() as AdminOverviewStats;
  const initialNow = new Date().getTime();

  return (
    <AdminDashboard
      initialApiKeys={apiKeys}
      initialChannels={channels}
      initialCredentials={codexCredentials}
      initialRequestLogsPage={{
        object: "list",
        data: requestLogs.data as RequestLogRow[],
        limit: requestLogs.limit,
        page: 1,
        offset: requestLogs.offset,
        total: requestLogs.total,
        totalPages: Math.max(
          1,
          Math.ceil(requestLogs.total / requestLogs.limit),
        ),
        summary: {
          errorCount: requestLogs.errorCount,
          totalTokens: requestLogs.totalTokens,
          avgLatencyMs: requestLogs.avgLatencyMs,
        },
      }}
      initialOverviewStats={overviewStats}
      initialNow={initialNow}
    />
  );
}
