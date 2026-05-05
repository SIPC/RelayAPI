"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  Clock3Icon,
  DatabaseIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RouteIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  Trash2Icon,
  WorkflowIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  adminErrorMessage,
  createApiKey,
  createChannel,
  deleteApiKey,
  deleteChannel,
  deleteCredential,
  finishCodexOAuth,
  getCredentialQuota,
  getDashboardSnapshot,
  getOverview,
  getRequestLogs,
  listChannels,
  listCredentials,
  logoutWebSession,
  refreshCredential,
  startCodexOAuth,
  WEB_AUTH_EXPIRED_EVENT,
  updateApiKey,
  updateChannel,
  type AdminDashboardRequestLogRow,
  type ApiKeyPayload,
  type ChannelPayload,
  type CodexQuotaReport,
  type OAuthStartResponse,
} from "@/lib/admin-api";
import type {
  AdminOverviewStats,
  ApiKeyUsageStatsRow,
  ChannelRecord,
  ChannelStatus,
  CodexCredentialRecord,
  CreatedApiKey,
  PublicApiKey,
  UsageStatsRow,
} from "@/src/shared/types/entities";

type AdminDashboardProps = {
  initialApiKeys: PublicApiKey[];
  initialChannels: ChannelRecord[];
  initialCredentials: CodexCredentialRecord[];
  initialRequestLogs: AdminDashboardRequestLogRow[];
  initialOverviewStats: AdminOverviewStats;
  initialNow: number;
};

type SectionId = "overview" | "apiKeys" | "credentials" | "channels" | "logs";
type LogStatusFilter = "all" | "success" | "error" | "stream";

type NavigationItem = {
  id: SectionId;
  label: string;
  description: string;
  icon: LucideIcon;
  count?: number;
};

type MetricCardProps = {
  title: string;
  value: string;
  description: string;
  icon: LucideIcon;
  tone?: "default" | "success" | "warning" | "danger";
};

type ApiKeyFormState = {
  name: string;
  enabled: boolean;
  scopes: string;
  modelAllowlist: string;
  channelAllowlist: string;
  tokenLimitDaily: string;
  rateLimitPerMinute: string;
  expiresAt: string;
};

type ChannelFormState = {
  name: string;
  credentialId: string;
  enabled: boolean;
  baseUrl: string;
  priority: string;
  weight: string;
  modelAllowlist: string;
};

const STATUS_LABELS: Record<ChannelStatus, string> = {
  healthy: "健康",
  degraded: "降级",
  cooling_down: "冷却中",
  disabled: "已禁用",
};

const LOG_STATUS_FILTERS: Array<{ id: LogStatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "success", label: "成功" },
  { id: "error", label: "错误" },
  { id: "stream", label: "流式" },
];

const WEB_SESSION_EXPIRED_MESSAGE = "管理台会话已过期，请重新登录";
const WEB_SESSION_EXPIRED_REDIRECT_MS = 2200;

const EMPTY_API_KEY_FORM: ApiKeyFormState = {
  name: "",
  enabled: true,
  scopes: "relay",
  modelAllowlist: "",
  channelAllowlist: "",
  tokenLimitDaily: "",
  rateLimitPerMinute: "",
  expiresAt: "",
};

const EMPTY_CHANNEL_FORM: ChannelFormState = {
  name: "",
  credentialId: "",
  enabled: true,
  baseUrl: "",
  priority: "100",
  weight: "1",
  modelAllowlist: "",
};

export function AdminDashboard({
  initialApiKeys,
  initialChannels,
  initialCredentials,
  initialRequestLogs,
  initialOverviewStats,
  initialNow,
}: AdminDashboardProps) {
  const [activeSection, setActiveSection] =
    React.useState<SectionId>("overview");
  const [apiKeys, setApiKeys] = React.useState(initialApiKeys);
  const [channels, setChannels] = React.useState(initialChannels);
  const [credentials, setCredentials] = React.useState(initialCredentials);
  const [requestLogs, setRequestLogs] = React.useState(initialRequestLogs);
  const [overviewStats, setOverviewStats] =
    React.useState(initialOverviewStats);
  const [snapshotTime, setSnapshotTime] = React.useState(initialNow);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = React.useState(
    WEB_SESSION_EXPIRED_MESSAGE,
  );
  const sessionRedirectTimerRef = React.useRef<number | null>(null);

  const returnToLogin = React.useCallback(() => {
    window.location.assign("/");
  }, []);

  React.useEffect(() => {
    function handleWebAuthExpired(event: Event) {
      const message =
        event instanceof CustomEvent &&
        typeof event.detail?.message === "string"
          ? event.detail.message
          : WEB_SESSION_EXPIRED_MESSAGE;

      setSessionExpired(true);
      setSessionExpiredMessage(message);

      if (sessionRedirectTimerRef.current === null) {
        sessionRedirectTimerRef.current = window.setTimeout(
          returnToLogin,
          WEB_SESSION_EXPIRED_REDIRECT_MS,
        );
      }
    }

    window.addEventListener(WEB_AUTH_EXPIRED_EVENT, handleWebAuthExpired);
    return () => {
      window.removeEventListener(WEB_AUTH_EXPIRED_EVENT, handleWebAuthExpired);
      if (sessionRedirectTimerRef.current !== null) {
        window.clearTimeout(sessionRedirectTimerRef.current);
        sessionRedirectTimerRef.current = null;
      }
    };
  }, [returnToLogin]);

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      const snapshot = await getDashboardSnapshot({ requestLogLimit: 100 });
      setApiKeys(snapshot.apiKeys);
      setChannels(snapshot.channels);
      setCredentials(snapshot.credentials);
      setRequestLogs(snapshot.requestLogs);
      setOverviewStats(snapshot.overviewStats);
      setSnapshotTime(snapshot.generatedAt);
      toast.success("管理数据已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await logoutWebSession();
      toast.success("已退出管理台");
      window.location.reload();
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  async function refreshOverviewStats() {
    const stats = await getOverview();
    setOverviewStats(stats);
    setSnapshotTime(Date.now());
    return stats;
  }

  async function refreshRequestLogs() {
    const logs = await getRequestLogs(100);
    setRequestLogs(logs);
    setSnapshotTime(Date.now());
    return logs;
  }

  function handleApiKeyCreated(created: CreatedApiKey) {
    setApiKeys((current) => [
      created,
      ...current.filter((apiKey) => apiKey.id !== created.id),
    ]);
  }

  function handleApiKeyUpdated(updated: PublicApiKey) {
    setApiKeys((current) =>
      current.map((apiKey) => (apiKey.id === updated.id ? updated : apiKey)),
    );
  }

  function handleApiKeyDeleted(id: string) {
    setApiKeys((current) => current.filter((apiKey) => apiKey.id !== id));
  }

  async function refreshCredentialAndChannelData() {
    const [nextCredentials, nextChannels] = await Promise.all([
      listCredentials(),
      listChannels(),
    ]);
    setCredentials(nextCredentials);
    setChannels(nextChannels);
    setSnapshotTime(Date.now());
    return { credentials: nextCredentials, channels: nextChannels };
  }

  function handleCredentialUpdated(updated: CodexCredentialRecord) {
    setCredentials((current) => [
      updated,
      ...current.filter((credential) => credential.id !== updated.id),
    ]);
  }

  function handleCredentialDeleted(id: string) {
    setCredentials((current) =>
      current.filter((credential) => credential.id !== id),
    );
    setChannels((current) =>
      current.filter((channel) => channel.credentialId !== id),
    );
  }

  function handleChannelCreated(created: ChannelRecord) {
    setChannels((current) => [
      created,
      ...current.filter((channel) => channel.id !== created.id),
    ]);
  }

  function handleChannelUpdated(updated: ChannelRecord) {
    setChannels((current) =>
      current.map((channel) => (channel.id === updated.id ? updated : channel)),
    );
  }

  function handleChannelDeleted(id: string) {
    setChannels((current) => current.filter((channel) => channel.id !== id));
  }

  const totals = overviewStats.totals;
  const enabledApiKeyCount = apiKeys.filter((key) => key.enabled).length;
  const enabledChannelCount = channels.filter(
    (channel) => channel.enabled,
  ).length;
  const healthyChannelCount = channels.filter(
    (channel) => channel.status === "healthy",
  ).length;
  const successRate = ratio(totals.successCount, totals.requestCount);
  const hasOperationalData = totals.requestCount > 0;

  const navigationItems: NavigationItem[] = [
    {
      id: "overview",
      label: "总览",
      description: "运行概览",
      icon: GaugeIcon,
    },
    {
      id: "credentials",
      label: "凭据",
      description: "Codex 账号",
      icon: UserRoundIcon,
      count: credentials.length,
    },
    {
      id: "channels",
      label: "通道",
      description: "路由通道",
      icon: RouteIcon,
      count: channels.length,
    },
    {
      id: "apiKeys",
      label: "密钥",
      description: "API 密钥",
      icon: KeyRoundIcon,
      count: apiKeys.length,
    },
    {
      id: "logs",
      label: "日志",
      description: "最近请求",
      icon: FileTextIcon,
      count: requestLogs.length,
    },
  ];

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto flex w-full max-w-450 flex-col gap-6 px-4 py-6 sm:px-6 2xl:px-10">
        <header className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                RelayAPI Dashboard
              </h1>
              <p className="mt-2 max-w-5xl text-sm text-muted-foreground">
                Dashboard 已接入服务端实时数据，可管理 API 密钥、Codex
                凭据、通道、额度和请求日志。
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={sessionExpired || loggingOut}
                onClick={logout}
              >
                {loggingOut ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <XCircleIcon data-icon="inline-start" />
                )}
                登出
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={sessionExpired || refreshing || loggingOut}
                onClick={refreshDashboard}
              >
                {refreshing ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新数据
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              数据快照：
              <LocalDateTime value={new Date(snapshotTime).toISOString()} />
            </p>
          </div>
        </header>

        {sessionExpired && (
          <Alert variant="destructive" className="items-start">
            <AlertTriangleIcon className="size-4" />
            <AlertTitle>管理台会话已过期</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>
                {sessionExpiredMessage}。系统将在{" "}
                {formatDuration(WEB_SESSION_EXPIRED_REDIRECT_MS)} 后返回登录页。
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={returnToLogin}
              >
                立即重新登录
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border bg-card p-2 shadow-sm lg:sticky lg:top-6">
            <nav className="grid gap-1">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeSection;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveSection(item.id)}
                    className={[
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    ].join(" ")}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-none">
                        {item.label}
                      </span>
                      <span
                        className={[
                          "mt-1 block text-xs leading-none",
                          active
                            ? "text-primary-foreground/75"
                            : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {item.description}
                      </span>
                    </span>
                    {typeof item.count === "number" && (
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 text-xs tabular-nums",
                          active
                            ? "bg-primary-foreground/15 text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        {formatNumber(item.count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <Separator className="my-2" />

            <div className="grid gap-2 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>API 密钥</span>
                <span className="font-medium text-foreground">
                  已启用 {formatNumber(enabledApiKeyCount)}/
                  {formatNumber(apiKeys.length)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>通道</span>
                <span className="font-medium text-foreground">
                  健康 {formatNumber(healthyChannelCount)}/
                  {formatNumber(channels.length)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>成功率</span>
                <span className="font-medium text-foreground">
                  {formatPercent(successRate)}
                </span>
              </div>
            </div>
          </aside>

          <section className="min-w-0">
            {activeSection === "overview" && (
              <OverviewSection
                apiKeyCount={apiKeys.length}
                channelCount={channels.length}
                credentialCount={credentials.length}
                enabledChannelCount={enabledChannelCount}
                hasOperationalData={hasOperationalData}
                overviewStats={overviewStats}
                onRefresh={refreshOverviewStats}
              />
            )}
            {activeSection === "apiKeys" && (
              <ApiKeysSection
                apiKeys={apiKeys}
                onCreated={handleApiKeyCreated}
                onDeleted={handleApiKeyDeleted}
                onUpdated={handleApiKeyUpdated}
              />
            )}
            {activeSection === "credentials" && (
              <CredentialsSection
                credentials={credentials}
                onDeleted={handleCredentialDeleted}
                onRefreshData={refreshCredentialAndChannelData}
                onUpdated={handleCredentialUpdated}
              />
            )}
            {activeSection === "channels" && (
              <ChannelsSection
                channels={channels}
                credentials={credentials}
                onCreated={handleChannelCreated}
                onDeleted={handleChannelDeleted}
                onUpdated={handleChannelUpdated}
              />
            )}
            {activeSection === "logs" && (
              <LogsSection
                requestLogs={requestLogs}
                onRefresh={refreshRequestLogs}
              />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function OverviewSection({
  apiKeyCount,
  channelCount,
  credentialCount,
  enabledChannelCount,
  hasOperationalData,
  overviewStats,
  onRefresh,
}: {
  apiKeyCount: number;
  channelCount: number;
  credentialCount: number;
  enabledChannelCount: number;
  hasOperationalData: boolean;
  overviewStats: AdminOverviewStats;
  onRefresh: () => Promise<AdminOverviewStats>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const { totals } = overviewStats;
  const successRate = ratio(totals.successCount, totals.requestCount);
  const topModels = overviewStats.byModel.slice(0, 5);
  const topApiKeys = overviewStats.byApiKey.slice(0, 5);
  const recentDays = overviewStats.byDay.slice(0, 7);

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
      toast.success("总览已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">运行观测</h2>
          <p className="text-sm text-muted-foreground">
            全量请求日志聚合统计；刷新只更新总览聚合数据，不影响配置。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          刷新总览
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="总请求数"
          value={formatNumber(totals.requestCount)}
          description={`${formatNumber(totals.streamCount)} 个流式 · ${formatNumber(totals.errorCount)} 个错误`}
          icon={ActivityIcon}
          tone={totals.errorCount > 0 ? "warning" : "default"}
        />
        <MetricCard
          title="成功率"
          value={formatPercent(successRate)}
          description={`${formatNumber(totals.successCount)} 成功 / ${formatNumber(totals.requestCount)} 总计`}
          icon={ShieldCheckIcon}
          tone={
            successRate === null || successRate >= 95 ? "success" : "warning"
          }
        />
        <MetricCard
          title="Token 总量"
          value={formatNumber(totals.totalTokens)}
          description={`${formatNumber(totals.promptTokens)} 输入 · ${formatNumber(totals.completionTokens)} 输出`}
          icon={DatabaseIcon}
        />
        <MetricCard
          title="延迟"
          value={formatDuration(totals.avgLatencyMs)}
          description={`p95 ${formatDuration(totals.p95LatencyMs)} · ${formatNumber(Math.round(totals.tokensPerSecond))} token/秒`}
          icon={Clock3Icon}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ResourceSummaryCard
          title="API 密钥"
          value={apiKeyCount}
          description="Relay 调用方认证密钥"
          icon={KeyRoundIcon}
        />
        <ResourceSummaryCard
          title="Codex 凭据"
          value={credentialCount}
          description="已授权的 Codex 账号"
          icon={UserRoundIcon}
        />
        <ResourceSummaryCard
          title="通道"
          value={channelCount}
          description={`${formatNumber(enabledChannelCount)} 个通道启用中`}
          icon={RouteIcon}
        />
      </div>

      {!hasOperationalData && (
        <Alert>
          <WorkflowIcon />
          <AlertTitle>还没有请求数据</AlertTitle>
          <AlertDescription>
            创建 Relay API 密钥、配置 Codex 凭据和通道后，调用
            `/v1/models`、`/v1/responses` 或 `/v1/chat/completions`
            即可在这里看到统计和日志。
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <UsageListCard
          title="模型排行"
          description="按 token 消耗排序"
          emptyTitle="暂无模型使用数据"
          rows={topModels}
        />
        <UsageListCard
          title="API 密钥排行"
          description="按 token 消耗排序"
          emptyTitle="暂无 API 密钥使用数据"
          rows={topApiKeys}
        />
        <DailyUsageCard rows={recentDays} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ApiKeyUsageCard rows={overviewStats.byApiKey} />
        <UsageStatsTableCard
          title="通道用量"
          description="按通道聚合的请求、错误和 token 消耗。"
          rows={overviewStats.byChannel}
          emptyTitle="暂无通道使用数据"
        />
        <UsageStatsTableCard
          title="凭据用量"
          description="按 Codex 凭据聚合的公开使用统计。"
          rows={overviewStats.byCredential}
          emptyTitle="暂无凭据使用数据"
        />
        <UsageStatsTableCard
          title="请求类型用量"
          description="按请求类型聚合，辅助区分模型、聊天、响应等入口。"
          rows={overviewStats.byRequestType}
          emptyTitle="暂无请求类型统计"
        />
      </div>
    </div>
  );
}

function ApiKeyUsageCard({ rows }: { rows: ApiKeyUsageStatsRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>API 密钥用量</CardTitle>
        <CardDescription>
          按 API 密钥聚合请求、成功率、token 消耗和今日额度利用率。
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 个密钥</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={KeyRoundIcon}
            title="暂无 API 密钥使用统计"
            description="使用 Relay API 密钥调用后，这里会展示每个密钥的消耗。"
            compact
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>API 密钥</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>今日上限</TableHead>
                <TableHead>延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className="font-medium">{row.apiKeyName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {row.apiKeyPrefix || row.apiKeyId || "-"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <CountCell row={row} />
                  </TableCell>
                  <TableCell>
                    {formatPercent(ratio(row.successCount, row.requestCount))}
                  </TableCell>
                  <TableCell>
                    <TokenCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LimitCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LatencyCell row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function UsageStatsTableCard({
  description,
  emptyTitle,
  rows,
  title,
}: {
  description: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 行</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="产生请求后会自动聚合。"
            compact
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className="font-medium">{row.label || row.key}</div>
                    {row.subLabel && (
                      <div className="text-xs text-muted-foreground">
                        {row.subLabel}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <CountCell row={row} />
                  </TableCell>
                  <TableCell>
                    {formatPercent(ratio(row.successCount, row.requestCount))}
                  </TableCell>
                  <TableCell>
                    <TokenCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LatencyCell row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CountCell({
  row,
}: {
  row: Pick<UsageStatsRow, "requestCount" | "errorCount" | "streamCount">;
}) {
  return (
    <div>
      <div className="font-medium">{formatNumber(row.requestCount)}</div>
      <div className="text-xs text-muted-foreground">
        {formatNumber(row.errorCount)} 个错误 · {formatNumber(row.streamCount)}{" "}
        个流式
      </div>
    </div>
  );
}

function TokenCell({
  row,
}: {
  row: Pick<
    UsageStatsRow,
    "promptTokens" | "completionTokens" | "totalTokens" | "avgTokensPerRequest"
  >;
}) {
  return (
    <div>
      <div className="font-medium">{formatNumber(row.totalTokens)}</div>
      <div className="text-xs text-muted-foreground">
        P {formatNumber(row.promptTokens)} · C{" "}
        {formatNumber(row.completionTokens)} · 平均{" "}
        {formatNumber(Math.round(row.avgTokensPerRequest))}
      </div>
    </div>
  );
}

function LimitCell({ row }: { row: ApiKeyUsageStatsRow }) {
  if (!row.tokenLimitDaily) {
    return <span className="text-muted-foreground">不限制</span>;
  }

  return (
    <div className="min-w-32 space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{formatNumber(row.todayTokens)}</span>
        <span className="text-muted-foreground">
          每日 {formatNumber(row.tokenLimitDaily)}
        </span>
      </div>
      <Progress value={clamp(row.tokenLimitUtilization || 0, 0, 100)} />
    </div>
  );
}

function LatencyCell({
  row,
}: {
  row: Pick<UsageStatsRow, "avgLatencyMs" | "p95LatencyMs" | "tokensPerSecond">;
}) {
  return (
    <div>
      <div className="font-medium">{formatDuration(row.avgLatencyMs)}</div>
      <div className="text-xs text-muted-foreground">
        p95 {formatDuration(row.p95LatencyMs)} ·{" "}
        {formatNumber(Math.round(row.tokensPerSecond))} token/秒
      </div>
    </div>
  );
}

function ApiKeysSection({
  apiKeys,
  onCreated,
  onDeleted,
  onUpdated,
}: {
  apiKeys: PublicApiKey[];
  onCreated: (apiKey: CreatedApiKey) => void;
  onDeleted: (id: string) => void;
  onUpdated: (apiKey: PublicApiKey) => void;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createdKey, setCreatedKey] = React.useState<CreatedApiKey | null>(
    null,
  );
  const [editingApiKey, setEditingApiKey] = React.useState<PublicApiKey | null>(
    null,
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function toggleEnabled(apiKey: PublicApiKey, enabled: boolean) {
    setPendingId(apiKey.id);
    try {
      const updated = await updateApiKey(apiKey.id, { enabled });
      onUpdated(updated);
      toast.success(enabled ? "API 密钥已启用" : "API 密钥已禁用");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function remove(apiKey: PublicApiKey) {
    setPendingId(apiKey.id);
    try {
      await deleteApiKey(apiKey.id);
      onDeleted(apiKey.id);
      toast.success("API 密钥已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API 密钥</CardTitle>
          <CardDescription>
            创建、启停、限制模型/通道、设置每日 token
            上限。完整密钥明文只会在创建后显示一次。
          </CardDescription>
          <CardAction>
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              新建密钥
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {apiKeys.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>还没有 Relay API 密钥</EmptyTitle>
                <EmptyDescription>
                  创建第一个密钥后，客户端即可通过 OpenAI 兼容接口访问 Relay。
                </EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                新建密钥
              </Button>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>权限范围</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>上限</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((apiKey) => (
                  <TableRow key={apiKey.id}>
                    <TableCell className="font-medium">{apiKey.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {apiKey.prefix}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={apiKey.enabled}
                          disabled={pendingId === apiKey.id}
                          size="sm"
                          onCheckedChange={(checked) =>
                            toggleEnabled(apiKey, Boolean(checked))
                          }
                        />
                        {renderEnabledBadge(apiKey.enabled)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {renderStringList(apiKey.scopes, "全部")}
                    </TableCell>
                    <TableCell>
                      {renderStringList(apiKey.modelAllowlist, "全部模型")}
                    </TableCell>
                    <TableCell>
                      {apiKey.tokenLimitDaily === null
                        ? "不限制"
                        : formatNumber(apiKey.tokenLimitDaily)}
                    </TableCell>
                    <TableCell>
                      {formatNullableDate(apiKey.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingApiKey(apiKey)}
                        >
                          <PencilIcon data-icon="inline-start" />
                        </Button>
                        <ApiKeyDeleteDialog
                          apiKey={apiKey}
                          disabled={pendingId === apiKey.id}
                          onConfirm={() => remove(apiKey)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ApiKeyFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => {
          onCreated(created as CreatedApiKey);
          setCreatedKey(created as CreatedApiKey);
        }}
      />
      <ApiKeyFormDialog
        apiKey={editingApiKey}
        mode="edit"
        open={Boolean(editingApiKey)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingApiKey(null);
          }
        }}
        onSaved={(updated) => {
          onUpdated(updated);
          setEditingApiKey(null);
        }}
      />
      <CreatedApiKeyDialog
        apiKey={createdKey}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
          }
        }}
      />
    </>
  );
}

function ApiKeyFormDialog({
  apiKey,
  mode,
  onOpenChange,
  onSaved,
  open,
}: {
  apiKey?: PublicApiKey | null;
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
  open: boolean;
}) {
  const initialForm =
    mode === "edit" && apiKey ? apiKeyToForm(apiKey) : EMPTY_API_KEY_FORM;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <ApiKeyFormDialogBody
            key={`${mode}:${apiKey?.id || "new"}`}
            apiKey={apiKey}
            initialForm={initialForm}
            mode={mode}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onSaved(saved);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyFormDialogBody({
  apiKey,
  initialForm,
  mode,
  onCancel,
  onSaved,
}: {
  apiKey?: PublicApiKey | null;
  initialForm: ApiKeyFormState;
  mode: "create" | "edit";
  onCancel: () => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
}) {
  const [form, setForm] = React.useState<ApiKeyFormState>(initialForm);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = apiKeyFormToPayload(form);
      const saved =
        mode === "create"
          ? await createApiKey(payload)
          : await updateApiKey(assertApiKey(apiKey).id, payload);
      onSaved(saved);
      toast.success(mode === "create" ? "API 密钥已创建" : "API 密钥已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {mode === "create" ? "新建 API 密钥" : "编辑 API 密钥"}
        </DialogTitle>
        <DialogDescription>
          完整密钥明文只会在创建成功后显示一次。编辑时不会重新生成明文密钥。
        </DialogDescription>
      </DialogHeader>
      <ApiKeyFields form={form} onChange={setForm} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          {mode === "create" ? "创建密钥" : "保存配置"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ApiKeyFields({
  form,
  onChange,
}: {
  form: ApiKeyFormState;
  onChange: React.Dispatch<React.SetStateAction<ApiKeyFormState>>;
}) {
  const update = <K extends keyof ApiKeyFormState>(
    key: K,
    value: ApiKeyFormState[K],
  ) => {
    onChange((current) => ({ ...current, [key]: value }));
  };

  return (
    <FieldSet>
      <FieldLegend>密钥配置</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="api-key-name">名称</FieldLabel>
          <Input
            id="api-key-name"
            value={form.name}
            placeholder="Relay API Key"
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="api-key-enabled">启用密钥</FieldLabel>
            <FieldDescription>
              关闭后，使用这个密钥的客户端会立即无法访问 Relay。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="api-key-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => update("enabled", Boolean(checked))}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="api-key-token-limit">
              每日 token 上限
            </FieldLabel>
            <Input
              id="api-key-token-limit"
              inputMode="numeric"
              placeholder="留空表示不限制"
              value={form.tokenLimitDaily}
              onChange={(event) =>
                update("tokenLimitDaily", event.target.value)
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="api-key-rate-limit">每分钟请求限制</FieldLabel>
            <Input
              id="api-key-rate-limit"
              inputMode="numeric"
              placeholder="留空表示不限制"
              value={form.rateLimitPerMinute}
              onChange={(event) =>
                update("rateLimitPerMinute", event.target.value)
              }
            />
            <FieldDescription>
              当前字段已保存到密钥配置；实际分钟限流由后端实现决定。
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="api-key-expires-at">过期时间</FieldLabel>
          <Input
            id="api-key-expires-at"
            type="datetime-local"
            value={form.expiresAt}
            onChange={(event) => update("expiresAt", event.target.value)}
          />
          <FieldDescription>留空表示不过期。</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="api-key-scopes">权限范围</FieldLabel>
          <Textarea
            id="api-key-scopes"
            className="min-h-20"
            value={form.scopes}
            placeholder="relay"
            onChange={(event) => update("scopes", event.target.value)}
          />
          <FieldDescription>
            每行或逗号分隔。为空时使用 relay。
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="api-key-models">模型白名单</FieldLabel>
          <Textarea
            id="api-key-models"
            className="min-h-24"
            value={form.modelAllowlist}
            placeholder="留空表示不限模型，例如 gpt-5.5 或 gpt-5.5(xhigh)"
            onChange={(event) => update("modelAllowlist", event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="api-key-channels">通道白名单</FieldLabel>
          <Textarea
            id="api-key-channels"
            className="min-h-24"
            value={form.channelAllowlist}
            placeholder="留空表示不限通道；可填写通道 ID"
            onChange={(event) => update("channelAllowlist", event.target.value)}
          />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

function CreatedApiKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: CreatedApiKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(apiKey)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>API 密钥只显示一次</DialogTitle>
          <DialogDescription>
            服务端只保存哈希。关闭后无法再次查看完整密钥，请立即复制保存。
          </DialogDescription>
        </DialogHeader>
        {apiKey && (
          <div className="grid gap-4">
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>{apiKey.name}</AlertTitle>
              <AlertDescription>
                后续列表只会显示前缀：{apiKey.prefix}。
              </AlertDescription>
            </Alert>
            <Field>
              <FieldLabel htmlFor="created-api-key">完整 API 密钥</FieldLabel>
              <Input id="created-api-key" readOnly value={apiKey.key} />
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => apiKey && copyText(apiKey.key)}
          >
            <CopyIcon data-icon="inline-start" />
            复制密钥
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyDeleteDialog({
  apiKey,
  disabled,
  onConfirm,
}: {
  apiKey: PublicApiKey;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" />
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除 API 密钥？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {apiKey.name}。使用这个密钥的客户端会立即无法访问 Relay。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CredentialsSection({
  credentials,
  onDeleted,
  onRefreshData,
  onUpdated,
}: {
  credentials: CodexCredentialRecord[];
  onDeleted: (id: string) => void;
  onRefreshData: () => Promise<{
    credentials: CodexCredentialRecord[];
    channels: ChannelRecord[];
  }>;
  onUpdated: (credential: CodexCredentialRecord) => void;
}) {
  const [oauthOpen, setOauthOpen] = React.useState(false);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [quotaLoadingIds, setQuotaLoadingIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [quotas, setQuotas] = React.useState<Record<string, CodexQuotaReport>>(
    {},
  );
  const [quotaErrors, setQuotaErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [refreshingAllQuotas, setRefreshingAllQuotas] = React.useState(false);
  const quotaLoadRequestedRef = React.useRef(new Set<string>());

  const setQuotaLoading = React.useCallback((id: string, loading: boolean) => {
    setQuotaLoadingIds((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  async function refreshToken(credential: CodexCredentialRecord) {
    setPendingId(credential.id);
    try {
      const updated = await refreshCredential(credential.id);
      onUpdated(updated);
      toast.success("Codex token 已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  const loadQuota = React.useCallback(
    async (
      credential: CodexCredentialRecord,
      options: { forceRefresh?: boolean; silent?: boolean } = {},
    ) => {
      const forceRefresh = options.forceRefresh ?? true;
      setQuotaLoading(credential.id, true);
      setQuotaErrors((current) => {
        if (!(credential.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[credential.id];
        return next;
      });

      try {
        const quota = await getCredentialQuota(credential.id, {
          refresh: forceRefresh,
        });
        setQuotas((current) => ({ ...current, [credential.id]: quota }));
        if (!options.silent) {
          toast.success(forceRefresh ? "额度已刷新" : "额度已读取");
        }
        return true;
      } catch (error) {
        const message = adminErrorMessage(error);
        setQuotaErrors((current) => ({ ...current, [credential.id]: message }));
        if (!options.silent) {
          toast.error(message);
        }
        return false;
      } finally {
        setQuotaLoading(credential.id, false);
      }
    },
    [setQuotaLoading],
  );

  const refreshAllQuotas = React.useCallback(async () => {
    if (credentials.length === 0) {
      return;
    }

    setRefreshingAllQuotas(true);
    try {
      const results = await Promise.all(
        credentials.map((credential) =>
          loadQuota(credential, { forceRefresh: true, silent: true }),
        ),
      );
      const failedCount = results.filter((success) => !success).length;
      if (failedCount > 0) {
        toast.error(`额度刷新完成，${formatNumber(failedCount)} 个账号失败`);
      } else {
        toast.success("全部额度已刷新");
      }
    } finally {
      setRefreshingAllQuotas(false);
    }
  }, [credentials, loadQuota]);

  React.useEffect(() => {
    credentials.forEach((credential) => {
      if (quotaLoadRequestedRef.current.has(credential.id)) {
        return;
      }
      quotaLoadRequestedRef.current.add(credential.id);
      void loadQuota(credential, { forceRefresh: true, silent: true });
    });
  }, [credentials, loadQuota]);

  const quotaRefreshPending = refreshingAllQuotas || quotaLoadingIds.size > 0;

  async function remove(credential: CodexCredentialRecord) {
    setPendingId(credential.id);
    try {
      await deleteCredential(credential.id);
      onDeleted(credential.id);
      toast.success("Codex 凭据已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Codex 凭据</CardTitle>
          <CardDescription>
            连接 Codex 账号、刷新 token、查看额度。Token 明文不会返回浏览器。
          </CardDescription>
          <CardAction>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={credentials.length === 0 || quotaRefreshPending}
                onClick={refreshAllQuotas}
              >
                {quotaRefreshPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新全部额度
              </Button>
              <Button type="button" onClick={() => setOauthOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                连接 Codex
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UserRoundIcon />
                </EmptyMedia>
                <EmptyTitle>还没有 Codex 凭据</EmptyTitle>
                <EmptyDescription>
                  通过 OAuth 连接 Codex 账号后，服务端会保存加密 token
                  并可创建默认通道。
                </EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={() => setOauthOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                连接 Codex
              </Button>
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {credentials.map((credential) => {
                const quota = quotas[credential.id];
                const quotaLoading = quotaLoadingIds.has(credential.id);
                const name =
                  credential.email || credential.accountId || "未知账号";

                return (
                  <Card
                    key={credential.id}
                    className="bg-linear-to-br from-card via-card to-muted/45 shadow-sm"
                  >
                    <CardContent className="grid gap-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge
                            variant="outline"
                            className={`h-6 shrink-0 px-3 text-sm font-semibold ${codexPlanBadgeTone(credential.planType)}`}
                          >
                            {codexPlanLabel(credential.planType)}
                          </Badge>
                          <div
                            className="min-w-0 truncate text-base font-medium"
                            title={name}
                          >
                            {name}
                          </div>
                        </div>
                        <div className="flex shrink-0 justify-end gap-1.5">
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="outline"
                            disabled={pendingId === credential.id}
                            onClick={() => refreshToken(credential)}
                            title="刷新 token"
                          >
                            {pendingId === credential.id ? (
                              <Spinner />
                            ) : (
                              <RefreshCwIcon />
                            )}
                          </Button>
                          <CredentialDeleteDialog
                            credential={credential}
                            disabled={pendingId === credential.id}
                            onConfirm={() => remove(credential)}
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          状态：
                        </span>
                        {credential.usageHealth ? (
                          <UsageHealthBadge
                            status={credential.usageHealth.status}
                          />
                        ) : (
                          <Badge variant="outline">未知</Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          过期时间：
                        </span>
                        <span className="min-w-0 truncate">
                          {formatNullableDate(credential.expiresAt)}
                        </span>
                      </div>

                      <div className="grid gap-2 text-sm">
                        <span className="text-muted-foreground">
                          剩余额度：
                        </span>
                        <div className="rounded-lg border border-border/60 bg-muted/35 p-3">
                          <QuotaProgressCell
                            errorMessage={quotaErrors[credential.id]}
                            loading={quotaLoading}
                            quota={quota}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <OAuthDialog
        open={oauthOpen}
        onOpenChange={setOauthOpen}
        onCompleted={onRefreshData}
      />
    </>
  );
}

function OAuthDialog({
  onCompleted,
  onOpenChange,
  open,
}: {
  onCompleted: () => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [session, setSession] = React.useState<OAuthStartResponse | null>(null);
  const [callbackUrl, setCallbackUrl] = React.useState("");

  async function startOAuth() {
    setPending(true);
    try {
      const started = await startCodexOAuth();
      setSession(started);
      toast.success("OAuth 链接已生成");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function finishOAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = callbackUrl.trim();
    if (!trimmed) {
      toast.error("请粘贴 OAuth callback URL 或 query string");
      return;
    }
    setPending(true);
    try {
      await finishCodexOAuth(trimmed);
      await onCompleted();
      setCallbackUrl("");
      setSession(null);
      onOpenChange(false);
      toast.success("Codex 凭据已连接");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form className="grid gap-4" onSubmit={finishOAuth}>
          <DialogHeader>
            <DialogTitle>连接 Codex 账号</DialogTitle>
            <DialogDescription>
              先生成 OAuth 链接并在浏览器打开，授权完成后把 callback URL 或
              query string 粘贴回来完成保存。
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>OAuth 链接</FieldLabel>
                <FieldDescription>
                  服务端会创建临时 PKCE state，并持久化到数据库以跨进程完成
                  callback。
                </FieldDescription>
              </FieldContent>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={startOAuth}
              >
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlusIcon data-icon="inline-start" />
                )}
                生成链接
              </Button>
            </Field>

            {session && (
              <div className="grid gap-3 rounded-xl border bg-muted/40 p-3">
                <div className="grid gap-1">
                  <div className="text-sm font-medium">Auth URL</div>
                  <Textarea
                    readOnly
                    className="min-h-24"
                    value={session.authUrl}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  Redirect URI：{session.redirectUri}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyText(session.authUrl)}
                  >
                    <CopyIcon data-icon="inline-start" />
                    复制 OAuth 链接
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      window.open(
                        session.authUrl,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    打开链接
                  </Button>
                </div>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor="oauth-callback-url">
                Callback URL 或 query string
              </FieldLabel>
              <Textarea
                id="oauth-callback-url"
                className="min-h-28"
                value={callbackUrl}
                placeholder="http://localhost:3000/api/admin/codex/credentials/oauth/callback?code=...&state=..."
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || !callbackUrl.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              完成连接
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuotaSummaryBadge({ quota }: { quota: CodexQuotaReport }) {
  if (quota.status === "not_cached" || quota.status === "unknown") {
    return <Badge variant="outline">{quotaStatusLabel(quota.status)}</Badge>;
  }
  if (quota.status === "exhausted" || quota.status === "low") {
    return (
      <Badge variant="destructive">{quotaStatusLabel(quota.status)}</Badge>
    );
  }
  return <Badge variant="secondary">{quotaStatusLabel(quota.status)}</Badge>;
}

function QuotaProgressCell({
  errorMessage,
  loading,
  quota,
}: {
  errorMessage?: string;
  loading: boolean;
  quota: CodexQuotaReport | undefined;
}) {
  if (!quota) {
    if (errorMessage) {
      return <span className="text-xs text-destructive">{errorMessage}</span>;
    }

    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {loading ? (
          <>
            <Spinner data-icon="inline-start" />
            读取中
          </>
        ) : (
          <Badge variant="outline">未读取</Badge>
        )}
      </div>
    );
  }

  const windows = [...quota.windows, ...quota.additional_windows];

  if (windows.length === 0) {
    return (
      <div className="grid gap-1">
        <QuotaSummaryBadge quota={quota} />
        <span className="text-xs text-muted-foreground">
          {quota.message || "没有可展示的额度窗口"}
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {windows.map((window, index) => {
        const remainingPercent = window.remaining_percent;
        const progressValue =
          remainingPercent === null ? 0 : clamp(remainingPercent, 0, 100);

        return (
          <div key={`${window.id}-${index}`} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                {window.label}
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {window.reset_label || "-"}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Progress
                className="min-w-0 flex-1 **:data-[slot=progress-track]:h-2"
                value={progressValue}
              />
              <span
                className={`w-9 shrink-0 text-right text-xs tabular-nums ${
                  window.exhausted
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {remainingPercent === null
                  ? "未知"
                  : `${Math.round(remainingPercent)}%`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CredentialDeleteDialog({
  credential,
  disabled,
  onConfirm,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="icon-sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="删除凭据"
      >
        <Trash2Icon />
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除 Codex 凭据？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {credential.email || credential.accountId || credential.id}
            。关联通道和额度缓存也可能受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ChannelsSection({
  channels,
  credentials,
  onCreated,
  onDeleted,
  onUpdated,
}: {
  channels: ChannelRecord[];
  credentials: CodexCredentialRecord[];
  onCreated: (channel: ChannelRecord) => void;
  onDeleted: (id: string) => void;
  onUpdated: (channel: ChannelRecord) => void;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingChannel, setEditingChannel] =
    React.useState<ChannelRecord | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const credentialsById = new Map(
    credentials.map((credential) => [credential.id, credential]),
  );

  async function toggleEnabled(channel: ChannelRecord, enabled: boolean) {
    setPendingId(channel.id);
    try {
      const updated = await updateChannel(channel.id, { enabled });
      onUpdated(updated);
      toast.success(enabled ? "通道已启用" : "通道已禁用");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function recover(channel: ChannelRecord) {
    setPendingId(channel.id);
    try {
      const updated = await updateChannel(channel.id, {
        status: "healthy",
        healthScore: 100,
        cooldownUntil: null,
      });
      onUpdated(updated);
      toast.success("通道已恢复健康");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function remove(channel: ChannelRecord) {
    setPendingId(channel.id);
    try {
      await deleteChannel(channel.id);
      onDeleted(channel.id);
      toast.success("通道已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <div className="grid gap-4">
        <Alert>
          <RouteIcon />
          <AlertTitle>自动路由规则</AlertTitle>
          <AlertDescription>
            Relay
            会先过滤已禁用、冷却中、凭据缺失和模型不匹配的通道；然后选择优先级最高的一组，并在同优先级内按权重加权随机。
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>通道</CardTitle>
            <CardDescription>
              配置自动路由单元、优先级、权重、健康状态与模型白名单。
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                disabled={credentials.length === 0}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon data-icon="inline-start" />
                新建通道
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {channels.length === 0 ? (
              <Empty className="min-h-64">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <RouteIcon />
                  </EmptyMedia>
                  <EmptyTitle>还没有通道</EmptyTitle>
                  <EmptyDescription>
                    添加 Codex
                    凭据后通常会自动创建默认通道，也可以手动创建多个通道做优先级和权重路由。
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  type="button"
                  disabled={credentials.length === 0}
                  onClick={() => setCreateOpen(true)}
                >
                  <PlusIcon data-icon="inline-start" />
                  新建通道
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>凭据</TableHead>
                    <TableHead>优先级</TableHead>
                    <TableHead>权重</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>健康度</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {channels.map((channel) => {
                    const credential = credentialsById.get(
                      channel.credentialId,
                    );
                    return (
                      <TableRow key={channel.id}>
                        <TableCell>
                          <div className="font-medium">{channel.name}</div>
                          <div className="max-w-80 truncate text-xs text-muted-foreground">
                            {channel.baseUrl}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            最后使用 {formatNullableDate(channel.lastUsedAt)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={channel.enabled}
                              disabled={pendingId === channel.id}
                              size="sm"
                              onCheckedChange={(checked) =>
                                toggleEnabled(channel, Boolean(checked))
                              }
                            />
                            {renderChannelStatusBadge(channel.status)}
                          </div>
                          {channel.cooldownUntil && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              冷却至 {formatNullableDate(channel.cooldownUntil)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {credential?.email || (
                            <span className="text-muted-foreground">未知</span>
                          )}
                        </TableCell>
                        <TableCell>{formatNumber(channel.priority)}</TableCell>
                        <TableCell>{formatNumber(channel.weight)}</TableCell>
                        <TableCell>
                          {renderStringList(channel.modelAllowlist, "全部模型")}
                        </TableCell>
                        <TableCell>
                          <div className="min-w-28 space-y-1">
                            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                              <span>分数</span>
                              <span className="tabular-nums">
                                {formatNumber(channel.healthScore)}
                              </span>
                            </div>
                            <Progress
                              value={clamp(channel.healthScore, 0, 100)}
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={pendingId === channel.id}
                              onClick={() => recover(channel)}
                            >
                              <RefreshCwIcon data-icon="inline-start" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingChannel(channel)}
                            >
                              <PencilIcon data-icon="inline-start" />
                            </Button>
                            <ChannelDeleteDialog
                              channel={channel}
                              disabled={pendingId === channel.id}
                              onConfirm={() => remove(channel)}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ChannelFormDialog
        credentials={credentials}
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => onCreated(created)}
      />
      <ChannelFormDialog
        channel={editingChannel}
        credentials={credentials}
        mode="edit"
        open={Boolean(editingChannel)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingChannel(null);
          }
        }}
        onSaved={(updated) => {
          onUpdated(updated);
          setEditingChannel(null);
        }}
      />
    </>
  );
}

function ChannelFormDialog({
  channel,
  credentials,
  mode,
  onOpenChange,
  onSaved,
  open,
}: {
  channel?: ChannelRecord | null;
  credentials: CodexCredentialRecord[];
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (channel: ChannelRecord) => void;
  open: boolean;
}) {
  const initialForm =
    mode === "edit" && channel
      ? channelToForm(channel)
      : {
          ...EMPTY_CHANNEL_FORM,
          credentialId: credentials[0]?.id || "",
        };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <ChannelFormDialogBody
            key={`${mode}:${channel?.id || credentials[0]?.id || "new"}`}
            channel={channel}
            credentials={credentials}
            initialForm={initialForm}
            mode={mode}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onSaved(saved);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelFormDialogBody({
  channel,
  credentials,
  initialForm,
  mode,
  onCancel,
  onSaved,
}: {
  channel?: ChannelRecord | null;
  credentials: CodexCredentialRecord[];
  initialForm: ChannelFormState;
  mode: "create" | "edit";
  onCancel: () => void;
  onSaved: (channel: ChannelRecord) => void;
}) {
  const [form, setForm] = React.useState(initialForm);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.credentialId.trim()) {
      toast.error("请选择 Codex 凭据");
      return;
    }
    setPending(true);
    try {
      const payload = channelFormToPayload(form);
      const saved =
        mode === "create"
          ? await createChannel(payload)
          : await updateChannel(assertChannel(channel).id, payload);
      onSaved(saved);
      toast.success(mode === "create" ? "通道已创建" : "通道已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "新建通道" : "编辑通道"}</DialogTitle>
        <DialogDescription>
          通道是自动路由单元。优先级越高越优先，同优先级下按权重加权选择。
        </DialogDescription>
      </DialogHeader>
      <ChannelFields credentials={credentials} form={form} onChange={setForm} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={pending || credentials.length === 0}>
          {pending && <Spinner data-icon="inline-start" />}
          {mode === "create" ? "创建通道" : "保存通道"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ChannelFields({
  credentials,
  form,
  onChange,
}: {
  credentials: CodexCredentialRecord[];
  form: ChannelFormState;
  onChange: React.Dispatch<React.SetStateAction<ChannelFormState>>;
}) {
  const update = <K extends keyof ChannelFormState>(
    key: K,
    value: ChannelFormState[K],
  ) => {
    onChange((current) => ({ ...current, [key]: value }));
  };

  return (
    <FieldSet>
      <FieldLegend>通道配置</FieldLegend>
      <FieldGroup>
        {credentials.length === 0 && (
          <Alert>
            <UserRoundIcon />
            <AlertTitle>需要先连接 Codex 凭据</AlertTitle>
            <AlertDescription>
              创建通道前必须至少有一个 Codex 凭据。
            </AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel htmlFor="channel-name">名称</FieldLabel>
          <Input
            id="channel-name"
            value={form.name}
            placeholder="Codex · account@example.com"
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="channel-credential">绑定凭据</FieldLabel>
          <select
            id="channel-credential"
            value={form.credentialId}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            onChange={(event) => update("credentialId", event.target.value)}
          >
            <option value="">选择 Codex 凭据</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.email || credential.accountId || credential.id}
              </option>
            ))}
          </select>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="channel-enabled">启用通道</FieldLabel>
            <FieldDescription>
              关闭后这个通道不会参与自动路由。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="channel-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => update("enabled", Boolean(checked))}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="channel-base-url">上游基础 URL</FieldLabel>
          <Input
            id="channel-base-url"
            value={form.baseUrl}
            placeholder="留空使用服务端默认 Codex 基础 URL"
            onChange={(event) => update("baseUrl", event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="channel-priority">优先级</FieldLabel>
            <Input
              id="channel-priority"
              inputMode="numeric"
              value={form.priority}
              onChange={(event) => update("priority", event.target.value)}
            />
            <FieldDescription>数值越高越优先。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="channel-weight">权重</FieldLabel>
            <Input
              id="channel-weight"
              inputMode="numeric"
              value={form.weight}
              onChange={(event) => update("weight", event.target.value)}
            />
            <FieldDescription>同优先级下按权重选择。</FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="channel-models">模型白名单</FieldLabel>
          <Textarea
            id="channel-models"
            className="min-h-24"
            value={form.modelAllowlist}
            placeholder="留空表示不限模型，例如 gpt-5.5 或 gpt-5.5(xhigh)"
            onChange={(event) => update("modelAllowlist", event.target.value)}
          />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

function ChannelDeleteDialog({
  channel,
  disabled,
  onConfirm,
}: {
  channel: ChannelRecord;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" />
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除通道？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {channel.name}。自动路由将不再选择这个通道。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LogsSection({
  onRefresh,
  requestLogs,
}: {
  onRefresh: () => Promise<AdminDashboardRequestLogRow[]>;
  requestLogs: AdminDashboardRequestLogRow[];
}) {
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] =
    React.useState<LogStatusFilter>("all");
  const [refreshing, setRefreshing] = React.useState(false);

  const filteredLogs = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return requestLogs.filter((log) => {
      if (statusFilter === "success" && log.status_code >= 400) {
        return false;
      }
      if (statusFilter === "error" && log.status_code < 400) {
        return false;
      }
      if (statusFilter === "stream" && !log.stream) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return [
        log.method,
        log.path,
        log.request_type,
        log.model,
        log.api_key_name,
        log.api_key_prefix,
        log.channel_name,
        log.credential_email,
        log.error_code,
        String(log.status_code),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [query, requestLogs, statusFilter]);

  const totalTokens = filteredLogs.reduce(
    (sum, log) => sum + log.total_tokens,
    0,
  );
  const errorCount = filteredLogs.filter(
    (log) => log.status_code >= 400,
  ).length;
  const avgLatency = filteredLogs.length
    ? filteredLogs.reduce((sum, log) => sum + log.latency_ms, 0) /
      filteredLogs.length
    : 0;

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
      toast.success("请求日志已刷新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          title="筛选后日志"
          value={formatNumber(filteredLogs.length)}
          description={`已加载 ${formatNumber(requestLogs.length)} 行`}
          icon={FileTextIcon}
        />
        <MetricCard
          title="筛选后错误"
          value={formatNumber(errorCount)}
          description={`错误率 ${formatPercent(ratio(errorCount, filteredLogs.length))}`}
          icon={AlertTriangleIcon}
          tone={errorCount > 0 ? "warning" : "success"}
        />
        <MetricCard
          title="筛选后 Token"
          value={formatNumber(totalTokens)}
          description={`平均延迟 ${formatDuration(avgLatency)}`}
          icon={DatabaseIcon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>请求日志</CardTitle>
          <CardDescription>
            最近 100 条公开请求日志。可按状态和关键字在浏览器内筛选。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              disabled={refreshing}
              onClick={refresh}
            >
              {refreshing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新日志
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索路径、模型、密钥、通道、错误..."
                className="pl-8"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {LOG_STATUS_FILTERS.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={statusFilter === item.id ? "secondary" : "outline"}
                  onClick={() => setStatusFilter(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

          {requestLogs.length === 0 ? (
            <EmptyState
              icon={FileTextIcon}
              title="还没有请求日志"
              description="创建 API 密钥并调用 Relay 接口后，这里会展示最近请求。"
            />
          ) : filteredLogs.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="没有匹配的日志"
              description="调整关键字或状态筛选条件后再试。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>延迟</TableHead>
                  <TableHead>密钥 / 通道</TableHead>
                  <TableHead>Token</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <LocalDateTime value={log.started_at} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {log.method} {log.path}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {log.request_type}
                        {log.stream ? " · 流式" : ""}
                      </div>
                    </TableCell>
                    <TableCell>{log.model || "-"}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {renderStatusCodeBadge(log.status_code)}
                        {log.error_code && (
                          <span className="text-xs text-destructive">
                            {log.error_code}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{formatDuration(log.latency_ms)}</TableCell>
                    <TableCell>
                      <div>{log.api_key_name || "未知密钥"}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {log.api_key_prefix || "-"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {log.channel_name || "-"} ·{" "}
                        {log.credential_email || "-"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {formatNumber(log.total_tokens)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        输入 {formatNumber(log.prompt_tokens)} / 输出{" "}
                        {formatNumber(log.completion_tokens)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "default",
}: MetricCardProps) {
  const toneClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
    default: "bg-primary/10 text-primary",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    danger: "bg-destructive/10 text-destructive",
  };

  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardAction>
          <div className={`rounded-lg p-2 ${toneClasses[tone]}`}>
            <Icon className="size-4" />
          </div>
        </CardAction>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function ResourceSummaryCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardAction>
          <span className="text-lg font-semibold tabular-nums">
            {formatNumber(value)}
          </span>
        </CardAction>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function UsageListCard({
  title,
  description,
  emptyTitle,
  rows,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="产生请求后会自动汇总。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row) => (
              <UsageListRow key={row.key} maxTokens={maxTokens} row={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageListRow({
  maxTokens,
  row,
}: {
  maxTokens: number;
  row: UsageStatsRow;
}) {
  const progressValue = maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;

  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {row.label || row.key || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatNumber(row.requestCount)} 次请求 ·{" "}
            {formatNumber(row.errorCount)} 个错误
          </div>
        </div>
        <div className="text-right text-sm font-medium tabular-nums">
          {formatNumber(row.totalTokens)}
          <div className="text-xs font-normal text-muted-foreground">
            tokens
          </div>
        </div>
      </div>
      <Progress value={clamp(progressValue, 0, 100)} />
    </div>
  );
}

function DailyUsageCard({ rows }: { rows: AdminOverviewStats["byDay"] }) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>每日用量</CardTitle>
        <CardDescription>最近 7 天 token 消耗</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无每日统计"
            description="产生请求后会自动按天聚合。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row) => {
              const progressValue =
                maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;
              return (
                <div key={row.date} className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{row.date}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(row.requestCount)} 次请求 ·{" "}
                        {formatNumber(row.errorCount)} 个错误
                      </div>
                    </div>
                    <div className="text-sm font-medium tabular-nums">
                      {formatNumber(row.totalTokens)}
                    </div>
                  </div>
                  <Progress value={clamp(progressValue, 0, 100)} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({
  compact = false,
  description,
  icon: Icon,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Empty className={compact ? "min-h-36" : "min-h-64"}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function UsageHealthBadge({
  status,
}: {
  status: CodexCredentialRecord["usageHealth"] extends infer Health
    ? Health extends { status: infer Status }
      ? Status
      : never
    : never;
}) {
  if (status === "normal") {
    return <Badge variant="secondary">正常</Badge>;
  }
  if (status === "warning") {
    return <Badge variant="outline">警告</Badge>;
  }
  if (status === "error") {
    return <Badge variant="destructive">错误</Badge>;
  }
  return <Badge variant="outline">未使用</Badge>;
}

function renderEnabledBadge(enabled: boolean) {
  return enabled ? (
    <Badge variant="secondary" className="gap-1.5">
      <CheckCircle2Icon data-icon="inline-start" className="size-3" />
      已启用
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1.5">
      <XCircleIcon data-icon="inline-start" className="size-3" />
      已禁用
    </Badge>
  );
}

function renderChannelStatusBadge(status: ChannelStatus) {
  if (status === "healthy") {
    return <Badge variant="secondary">{STATUS_LABELS[status]}</Badge>;
  }
  if (status === "degraded" || status === "cooling_down") {
    return <Badge variant="outline">{STATUS_LABELS[status]}</Badge>;
  }
  return <Badge variant="destructive">{STATUS_LABELS[status]}</Badge>;
}

function renderStatusCodeBadge(statusCode: number) {
  if (statusCode >= 200 && statusCode < 400) {
    return <Badge variant="secondary">{statusCode}</Badge>;
  }
  if (statusCode >= 400) {
    return <Badge variant="destructive">{statusCode}</Badge>;
  }
  return <Badge variant="outline">{statusCode || "待处理"}</Badge>;
}

function renderStringList(values: string[], emptyLabel: string) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">{emptyLabel}</span>;
  }

  return (
    <div className="flex max-w-64 flex-wrap gap-1">
      {values.slice(0, 3).map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
      {values.length > 3 && (
        <Badge variant="outline">+{values.length - 3}</Badge>
      )}
    </div>
  );
}

function apiKeyToForm(apiKey: PublicApiKey): ApiKeyFormState {
  return {
    name: apiKey.name,
    enabled: apiKey.enabled,
    scopes: apiKey.scopes.join("\n") || "relay",
    modelAllowlist: apiKey.modelAllowlist.join("\n"),
    channelAllowlist: apiKey.channelAllowlist.join("\n"),
    tokenLimitDaily: apiKey.tokenLimitDaily?.toString() || "",
    rateLimitPerMinute: apiKey.rateLimitPerMinute?.toString() || "",
    expiresAt: isoToLocalDateTime(apiKey.expiresAt),
  };
}

function apiKeyFormToPayload(form: ApiKeyFormState): ApiKeyPayload {
  const scopes = parseList(form.scopes);
  return {
    name: form.name.trim() || "Relay API 密钥",
    enabled: form.enabled,
    scopes: scopes.length > 0 ? scopes : ["relay"],
    modelAllowlist: parseList(form.modelAllowlist),
    channelAllowlist: parseList(form.channelAllowlist),
    tokenLimitDaily: nullablePositiveInteger(form.tokenLimitDaily),
    rateLimitPerMinute: nullablePositiveInteger(form.rateLimitPerMinute),
    expiresAt: localDateTimeToIso(form.expiresAt),
  };
}

function assertApiKey(apiKey: PublicApiKey | null | undefined) {
  if (!apiKey) {
    throw new Error("缺少 API 密钥");
  }
  return apiKey;
}

function channelToForm(channel: ChannelRecord): ChannelFormState {
  return {
    name: channel.name,
    credentialId: channel.credentialId,
    enabled: channel.enabled,
    baseUrl: channel.baseUrl,
    priority: channel.priority.toString(),
    weight: channel.weight.toString(),
    modelAllowlist: channel.modelAllowlist.join("\n"),
  };
}

function channelFormToPayload(form: ChannelFormState): ChannelPayload {
  return {
    name: form.name.trim(),
    credentialId: form.credentialId.trim(),
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    priority: integerValue(form.priority, 100),
    weight: Math.max(1, integerValue(form.weight, 1)),
    modelAllowlist: parseList(form.modelAllowlist),
  };
}

function assertChannel(channel: ChannelRecord | null | undefined) {
  if (!channel) {
    throw new Error("缺少通道");
  }
  return channel;
}

function parseList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function nullablePositiveInteger(value: string) {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function integerValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function localDateTimeToIso(value: string) {
  if (!value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : value.trim();
}

function isoToLocalDateTime(value: string | null) {
  if (!value) {
    return "";
  }
  const date = parseUtcDate(value);
  if (!date) {
    return "";
  }
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

function formatNullableDate(value: string | null) {
  return value ? (
    <LocalDateTime value={value} />
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

function LocalDateTime({ value }: { value: string }) {
  const isClient = React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const date = parseUtcDate(value);
  return (
    <time dateTime={date?.toISOString()} suppressHydrationWarning>
      {isClient ? formatDateTime(value) : "-"}
    </time>
  );
}

function subscribeNoop() {
  return () => undefined;
}

function formatDateTime(value: string) {
  const date = parseUtcDate(value);
  if (!date) {
    return "-";
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function parseUtcDate(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes(" ")
    ? trimmed.replace(" ", "T")
    : trimmed;
  const normalizedWithTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalizedWithTime);
  const timestamp = Date.parse(
    hasTimeZone ? normalizedWithTime : `${normalizedWithTime}Z`,
  );
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function codexPlanLabel(planType: string) {
  const normalized = codexPlanKey(planType);
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro 20x",
    prolite: "Pro 5x",
    "pro-lite": "Pro 5x",
    pro_lite: "Pro 5x",
    team: "Team",
  };
  return labels[normalized] || planType || "未知";
}

function codexPlanBadgeTone(planType: string) {
  const normalized = codexPlanKey(planType);
  if (
    normalized === "pro" ||
    normalized === "prolite" ||
    normalized === "pro-lite" ||
    normalized === "pro_lite"
  ) {
    return "border-amber-400/70 bg-amber-300/25 text-amber-700 shadow-sm dark:border-amber-300/60 dark:bg-amber-300/20 dark:text-amber-200";
  }
  if (normalized === "team") {
    return "border-violet-500/45 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  }
  if (normalized === "plus") {
    return "border-primary/45 bg-primary/10 text-primary";
  }
  if (normalized === "free") {
    return "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  return "border-border bg-muted/60 text-foreground";
}

function codexPlanKey(planType: string) {
  return planType.trim().toLowerCase();
}

function quotaStatusLabel(status: CodexQuotaReport["status"]) {
  const labels: Record<CodexQuotaReport["status"], string> = {
    unknown: "未知",
    exhausted: "已耗尽",
    low: "偏低",
    medium: "中等",
    high: "充足",
    full: "满额",
    not_cached: "未缓存",
  };
  return labels[status] || status;
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 ms";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

function ratio(numerator: number, denominator: number) {
  if (!denominator) {
    return null;
  }
  return (numerator / denominator) * 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
