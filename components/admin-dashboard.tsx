"use client";

import * as React from "react";
import { Line, LineChart } from "recharts";
import { toast } from "sonner";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  Clock3Icon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RouteIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  Trash2Icon,
  UploadIcon,
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
  createProxyPoolItem,
  deleteApiKey,
  deleteChannel,
  deleteCredential,
  deleteProxyPoolItem,
  downloadCredentialsExport,
  finishCodexOAuth,
  getCredentialQuota,
  getDashboardSnapshot,
  getOverview,
  getRequestLogDetail,
  getRequestLogsPage,
  importCredentialJson,
  listChannels,
  listCredentials,
  listProxyPoolItems,
  logoutWebSession,
  pruneRequestLogs,
  refreshCredential,
  updateGlobalSettings,
  startCodexOAuth,
  WEB_AUTH_EXPIRED_EVENT,
  updateApiKey,
  updateChannel,
  updateCredentialRouting,
  updateProxyPoolItem,
  type AdminDashboardRequestLogRow,
  type ApiKeyPayload,
  type ChannelPayload,
  type CodexQuotaReport,
  type OAuthStartResponse,
  type ProxyPoolPayload,
  type RequestLogDetail,
  type RequestLogsPage,
} from "@/lib/admin-api";
import type {
  AdminOverviewStats,
  ApiKeyUsageStatsRow,
  ChannelRecord,
  ChannelStatus,
  CodexCredentialRecord,
  CodexUpstreamTransport,
  CredentialProxyType,
  CreatedApiKey,
  GlobalSettingsRecord,
  ProxyPoolRecord,
  PublicApiKey,
  UsageStatsRow,
} from "@/src/shared/types/entities";

type AdminDashboardProps = {
  initialApiKeys: PublicApiKey[];
  initialChannels: ChannelRecord[];
  initialCredentials: CodexCredentialRecord[];
  initialProxyPool: ProxyPoolRecord[];
  initialRequestLogsPage: RequestLogsPage;
  initialOverviewStats: AdminOverviewStats;
  initialGlobalSettings: GlobalSettingsRecord;
  initialNow: number;
};

type SectionId =
  | "overview"
  | "apiKeys"
  | "credentials"
  | "proxyPool"
  | "channels"
  | "settings"
  | "logs";
type LogStatusFilter = "all" | "success" | "error";

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

type TrendDirection = "up" | "down" | "flat";
type TrendTone = "positive" | "negative" | "neutral";

type TrendPoint = {
  date: string;
  value: number;
};

type TrendMetricCardProps = {
  title: string;
  value: string;
  description: string;
  changeLabel: string;
  direction: TrendDirection;
  tone: TrendTone;
  data: TrendPoint[];
  icon: LucideIcon;
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

type CredentialProxyFormState = {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

type ProxyPoolFormState = CredentialProxyFormState & {
  name: string;
  notes: string;
};

type ChannelFormState = {
  name: string;
  credentialIds: string;
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
  credentialIds: "",
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
  initialProxyPool,
  initialRequestLogsPage,
  initialOverviewStats,
  initialGlobalSettings,
  initialNow,
}: AdminDashboardProps) {
  const [activeSection, setActiveSection] =
    React.useState<SectionId>("overview");
  const [apiKeys, setApiKeys] = React.useState(initialApiKeys);
  const [channels, setChannels] = React.useState(initialChannels);
  const [credentials, setCredentials] = React.useState(initialCredentials);
  const [proxyPool, setProxyPool] = React.useState(initialProxyPool);
  const [globalSettings, setGlobalSettings] = React.useState(
    initialGlobalSettings,
  );
  const [requestLogs, setRequestLogs] = React.useState(
    initialRequestLogsPage.data,
  );
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
      setProxyPool(snapshot.proxyPool);
      setGlobalSettings(snapshot.globalSettings);
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

  function handleRequestLogsLoaded(logs: AdminDashboardRequestLogRow[]) {
    setRequestLogs(logs);
    setSnapshotTime(Date.now());
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
      current
        .map((channel) => {
          const credentialIds = channel.credentialIds.filter(
            (credentialId) => credentialId !== id,
          );
          return {
            ...channel,
            credentialId: credentialIds[0] || channel.credentialId,
            credentialIds,
          };
        })
        .filter((channel) => channel.credentialIds.length > 0),
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
      id: "proxyPool",
      label: "代理池",
      description: "SOCKS 代理",
      icon: DatabaseIcon,
      count: proxyPool.length,
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
    {
      id: "settings",
      label: "设置",
      description: "全局配置",
      icon: SettingsIcon,
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
                channels={channels}
                onCreated={handleApiKeyCreated}
                onDeleted={handleApiKeyDeleted}
                onUpdated={handleApiKeyUpdated}
              />
            )}
            {activeSection === "credentials" && (
              <CredentialsSection
                credentials={credentials}
                globalSettings={globalSettings}
                proxyPool={proxyPool}
                onDeleted={handleCredentialDeleted}
                onRefreshData={refreshCredentialAndChannelData}
                onUpdated={handleCredentialUpdated}
              />
            )}
            {activeSection === "proxyPool" && (
              <ProxyPoolSection
                proxyPool={proxyPool}
                onChanged={setProxyPool}
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
            {activeSection === "settings" && (
              <SettingsSection
                key={`${globalSettings.proxySource}:${globalSettings.proxy?.enabled}:${globalSettings.proxy?.type}:${globalSettings.proxy?.host}:${globalSettings.proxy?.port}:${globalSettings.proxy?.username}:${globalSettings.proxy?.passwordSet}:${globalSettings.userAgentSource}:${globalSettings.userAgent}:${globalSettings.fullRequestLoggingEnabled}:${globalSettings.codexAutoDisableRefreshExhausted}:${globalSettings.requestLogRetentionDays}:${globalSettings.requestLogDetailRetentionDays}:${globalSettings.updatedAt}`}
                settings={globalSettings}
                onSaved={setGlobalSettings}
              />
            )}
            {activeSection === "logs" && (
              <LogsSection
                initialRequestLogsPage={{
                  ...initialRequestLogsPage,
                  data: requestLogs,
                }}
                onLoaded={handleRequestLogsLoaded}
              />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function SettingsSection({
  settings,
  onSaved,
}: {
  settings: GlobalSettingsRecord;
  onSaved: (settings: GlobalSettingsRecord) => void;
}) {
  const [form, setForm] = React.useState(() =>
    globalSettingsProxyForm(settings),
  );
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [userAgent, setUserAgent] = React.useState(settings.userAgent);
  const [userAgentSaving, setUserAgentSaving] = React.useState(false);
  const [loggingSaving, setLoggingSaving] = React.useState(false);
  const [refreshPolicySaving, setRefreshPolicySaving] = React.useState(false);
  const [retentionSaving, setRetentionSaving] = React.useState(false);
  const [pruning, setPruning] = React.useState(false);
  const [retentionForm, setRetentionForm] = React.useState(() => ({
    requestLogRetentionDays: String(settings.requestLogRetentionDays ?? 90),
    requestLogDetailRetentionDays: String(
      settings.requestLogDetailRetentionDays ?? 14,
    ),
    vacuum: false,
  }));
  const proxy = settings.proxy;

  function patchForm(patch: Partial<CredentialProxyFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function saveProxy() {
    const host = form.host.trim();
    const port = integerValue(form.port, 0);
    if (!host) {
      toast.error("请输入全局 SOCKS5 代理主机");
      return;
    }
    if (port < 1 || port > 65535) {
      toast.error("代理端口必须在 1 到 65535 之间");
      return;
    }

    setSaving(true);
    try {
      const payload: {
        enabled: boolean;
        type: CredentialProxyType;
        host: string;
        port: number;
        username: string;
        password?: string;
      } = {
        enabled: form.enabled,
        type: form.type,
        host,
        port,
        username: form.username.trim(),
      };
      if (form.password.trim()) {
        payload.password = form.password;
      }
      const updated = await updateGlobalSettings({ proxy: payload });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("OAuth 登录代理已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearProxy() {
    setClearing(true);
    try {
      const updated = await updateGlobalSettings({ proxy: null });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("OAuth 登录代理已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  async function clearPassword() {
    if (!proxy) {
      return;
    }
    setSaving(true);
    try {
      const updated = await updateGlobalSettings({
        proxy: {
          enabled: proxy.enabled,
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: "",
        },
      });
      onSaved(updated);
      setForm(globalSettingsProxyForm(updated));
      toast.success("全局代理密码已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUserAgent() {
    const value = userAgent.trim();
    setUserAgentSaving(true);
    try {
      const updated = await updateGlobalSettings({ userAgent: value || null });
      onSaved(updated);
      setUserAgent(updated.userAgent);
      toast.success(
        value ? "全局 User-Agent 已保存" : "全局 User-Agent 已清除",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setUserAgentSaving(false);
    }
  }

  async function clearUserAgent() {
    setUserAgentSaving(true);
    try {
      const updated = await updateGlobalSettings({ userAgent: null });
      onSaved(updated);
      setUserAgent(updated.userAgent);
      toast.success("已回退到环境变量或默认 User-Agent");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setUserAgentSaving(false);
    }
  }

  async function updateFullRequestLogging(enabled: boolean) {
    setLoggingSaving(true);
    try {
      const updated = await updateGlobalSettings({
        fullRequestLoggingEnabled: enabled,
      });
      onSaved(updated);
      toast.success(enabled ? "完整转发日志已开启" : "完整转发日志已关闭");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoggingSaving(false);
    }
  }

  async function updateCodexAutoDisableRefreshExhausted(enabled: boolean) {
    setRefreshPolicySaving(true);
    try {
      const updated = await updateGlobalSettings({
        codexAutoDisableRefreshExhausted: enabled,
      });
      onSaved(updated);
      toast.success(
        enabled
          ? "Token 刷新失败自动禁用已开启"
          : "Token 刷新失败自动禁用已关闭",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshPolicySaving(false);
    }
  }

  async function saveRetentionSettings() {
    const requestLogRetentionDays = integerValue(
      retentionForm.requestLogRetentionDays,
      settings.requestLogRetentionDays ?? 90,
    );
    const requestLogDetailRetentionDays = integerValue(
      retentionForm.requestLogDetailRetentionDays,
      settings.requestLogDetailRetentionDays ?? 14,
    );
    if (!isValidRetentionDays(requestLogRetentionDays)) {
      toast.error("概要日志保留天数必须在 1 到 3650 之间");
      return;
    }
    if (!isValidRetentionDays(requestLogDetailRetentionDays)) {
      toast.error("详细日志保留天数必须在 1 到 3650 之间");
      return;
    }

    setRetentionSaving(true);
    try {
      const updated = await updateGlobalSettings({
        requestLogRetentionDays,
        requestLogDetailRetentionDays,
      });
      onSaved(updated);
      setRetentionForm((current) => ({
        ...current,
        requestLogRetentionDays: String(updated.requestLogRetentionDays ?? 90),
        requestLogDetailRetentionDays: String(
          updated.requestLogDetailRetentionDays ?? 14,
        ),
      }));
      toast.success("日志保留策略已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRetentionSaving(false);
    }
  }

  async function pruneLogsNow() {
    const summaryRetentionDays = integerValue(
      retentionForm.requestLogRetentionDays,
      settings.requestLogRetentionDays ?? 90,
    );
    const detailRetentionDays = integerValue(
      retentionForm.requestLogDetailRetentionDays,
      settings.requestLogDetailRetentionDays ?? 14,
    );
    if (!isValidRetentionDays(summaryRetentionDays)) {
      toast.error("概要日志保留天数必须在 1 到 3650 之间");
      return;
    }
    if (!isValidRetentionDays(detailRetentionDays)) {
      toast.error("详细日志保留天数必须在 1 到 3650 之间");
      return;
    }

    setPruning(true);
    try {
      const result = await pruneRequestLogs({
        summaryRetentionDays,
        detailRetentionDays,
        vacuum: retentionForm.vacuum,
      });
      toast.success(
        `日志清理完成：概要 ${formatNumber(result.deletedRequestLogs)} 条，详情 ${formatNumber(result.deletedRequestLogDetails)} 条`,
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPruning(false);
    }
  }

  const pending = saving || clearing;
  const retentionPending = retentionSaving || pruning;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
          <CardDescription>
            配置 Codex 上游 User-Agent、日志策略和 OAuth 登录专用 SOCKS5
            代理。凭据也可以单独覆盖 User-Agent。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          <Alert className="items-start xl:col-span-2">
            <SettingsIcon className="size-4" />
            <AlertTitle>生效范围</AlertTitle>
            <AlertDescription>
              User-Agent 按“凭据覆盖 → 数据库全局设置 →
              环境变量/默认值”生效。全局代理用于 OAuth 登录 callback 换
              token；后续 refresh_token
              和额度查询需在单个凭据中开启全局代理回退。
            </AlertDescription>
          </Alert>

          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm xl:col-span-2">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">Codex User-Agent</div>
                <div className="text-xs text-muted-foreground">
                  当前来源：{userAgentSourceLabel(settings.userAgentSource)}
                  。用于 Codex
                  请求和额度刷新；留空保存会回退到环境变量或默认值。
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    userAgentSaving || settings.userAgentSource !== "database"
                  }
                  onClick={clearUserAgent}
                >
                  {userAgentSaving && <Spinner data-icon="inline-start" />}
                  清除数据库配置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={userAgentSaving}
                  onClick={saveUserAgent}
                >
                  {userAgentSaving && <Spinner data-icon="inline-start" />}
                  保存 User-Agent
                </Button>
              </div>
            </div>
            <Textarea
              className="min-h-20 font-mono text-xs"
              disabled={userAgentSaving}
              value={userAgent}
              placeholder={settings.userAgent}
              onChange={(event) => setUserAgent(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              当前生效：{settings.userAgent || "未配置"}
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">记录完整日志</div>
                <div className="text-xs text-muted-foreground">
                  开启后记录完整请求 body、转发到上游的 payload
                  和上游响应；关闭后只保留概要日志与报错详情。
                </div>
              </div>
              <Switch
                checked={settings.fullRequestLoggingEnabled}
                disabled={loggingSaving}
                size="sm"
                onCheckedChange={(checked) =>
                  void updateFullRequestLogging(Boolean(checked))
                }
              />
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">自动停用错误凭据</div>
                <div className="text-xs text-muted-foreground">
                  Token 定时刷新始终会在凭据过期前 4
                  天尝试执行；失败后每天再试，最多总共尝试 3
                  次。开启此开关后，达到次数上限的错误凭据会自动停用；关闭时仅标记错误，不影响自动刷新。
                </div>
              </div>
              <Switch
                checked={settings.codexAutoDisableRefreshExhausted}
                disabled={refreshPolicySaving}
                size="sm"
                onCheckedChange={(checked) =>
                  void updateCodexAutoDisableRefreshExhausted(Boolean(checked))
                }
              />
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="grid gap-1">
                <div className="font-medium">日志保留与清理</div>
                <div className="text-xs text-muted-foreground">
                  概要日志会影响总览统计；详细日志包含请求/响应体，建议保留更短时间。
                  系统会在请求日志写入时按策略自动清理；“立即清理”只用于马上执行一次。
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={retentionPending}
                  onClick={saveRetentionSettings}
                >
                  {retentionSaving && <Spinner data-icon="inline-start" />}
                  保存策略
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={retentionPending}
                  onClick={pruneLogsNow}
                >
                  {pruning && <Spinner data-icon="inline-start" />}
                  立即清理
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                概要日志保留天数
                <Input
                  disabled={retentionPending}
                  inputMode="numeric"
                  value={retentionForm.requestLogRetentionDays}
                  onChange={(event) =>
                    setRetentionForm((current) => ({
                      ...current,
                      requestLogRetentionDays: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                详细日志保留天数
                <Input
                  disabled={retentionPending}
                  inputMode="numeric"
                  value={retentionForm.requestLogDetailRetentionDays}
                  onChange={(event) =>
                    setRetentionForm((current) => ({
                      ...current,
                      requestLogDetailRetentionDays: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={retentionForm.vacuum}
                disabled={retentionPending}
                onChange={(event) =>
                  setRetentionForm((current) => ({
                    ...current,
                    vacuum: event.target.checked,
                  }))
                }
              />
              <span>
                清理后执行 VACUUM
                释放磁盘空间。大日志库可能耗时较久，期间会阻塞日志库写入。
              </span>
            </label>

            <div className="text-xs text-muted-foreground">
              当前策略：概要{" "}
              {formatNumber(settings.requestLogRetentionDays ?? 90)} 天 · 详细{" "}
              {formatNumber(settings.requestLogDetailRetentionDays ?? 14)} 天
            </div>
          </div>

          <div className="grid h-full gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">OAuth 登录代理</div>
                <div className="text-xs text-muted-foreground">
                  当前来源：{globalProxySourceLabel(settings.proxySource)} ·
                  当前：
                  {globalProxyText(settings)}
                </div>
              </div>
              <Switch
                checked={form.enabled}
                disabled={pending}
                size="sm"
                onCheckedChange={(checked) =>
                  patchForm({ enabled: Boolean(checked) })
                }
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-[0.8fr_1fr_0.7fr]">
              <label className="grid gap-1 text-xs text-muted-foreground">
                协议
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={pending}
                  value={form.type}
                  onChange={(event) =>
                    patchForm({
                      type: event.target.value as CredentialProxyType,
                    })
                  }
                >
                  <option value="socks5h">socks5h</option>
                  <option value="socks5">socks5</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                主机
                <Input
                  disabled={pending}
                  value={form.host}
                  placeholder="127.0.0.1"
                  onChange={(event) => patchForm({ host: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                端口
                <Input
                  disabled={pending}
                  inputMode="numeric"
                  value={form.port}
                  placeholder="1080"
                  onChange={(event) => patchForm({ port: event.target.value })}
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                用户名（可选）
                <Input
                  disabled={pending}
                  value={form.username}
                  placeholder="username"
                  onChange={(event) =>
                    patchForm({ username: event.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                密码（留空则保持原密码）
                <Input
                  disabled={pending}
                  type="password"
                  value={form.password}
                  placeholder={
                    proxy?.passwordSet ? "已设置，留空保持不变" : "password"
                  }
                  onChange={(event) =>
                    patchForm({ password: event.target.value })
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                数据库配置更新时间：{formatNullableDate(settings.updatedAt)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    pending ||
                    settings.proxySource !== "database" ||
                    !proxy?.passwordSet
                  }
                  onClick={clearPassword}
                >
                  {saving && <Spinner data-icon="inline-start" />}
                  清除密码
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || settings.proxySource !== "database"}
                  onClick={clearProxy}
                >
                  {clearing && <Spinner data-icon="inline-start" />}
                  清除数据库代理
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={saveProxy}
                >
                  {saving && <Spinner data-icon="inline-start" />}
                  保存全局代理
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
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
  const trendMetrics = buildOverviewTrendMetrics(overviewStats.byDay);
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
        {trendMetrics.map((metric) => (
          <TrendMetricCard key={metric.title} {...metric} />
        ))}
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
              {rows.slice(0, 10).map((row, index) => (
                <TableRow key={`${row.key}:${index}`}>
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
              {rows.slice(0, 10).map((row, index) => (
                <TableRow key={`${row.key}:${index}`}>
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
    | "promptTokens"
    | "completionTokens"
    | "totalTokens"
    | "cachedTokens"
    | "cacheHitRate"
    | "avgTokensPerRequest"
  >;
}) {
  return (
    <div>
      <div className="font-medium">{formatTokenNumber(row.totalTokens)}</div>
      <div className="text-xs text-muted-foreground">
        P {formatTokenNumber(row.promptTokens)} · C{" "}
        {formatTokenNumber(row.completionTokens)} · 平均{" "}
        {formatTokenNumber(Math.round(row.avgTokensPerRequest))}
      </div>
      <div className="text-xs text-muted-foreground">
        缓存 {formatTokenNumber(row.cachedTokens)} · 命中率{" "}
        {formatPercent(row.cacheHitRate)}
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
        <span>{formatTokenNumber(row.todayTokens)}</span>
        <span className="text-muted-foreground">
          每日 {formatTokenNumber(row.tokenLimitDaily)}
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
        {formatTokenNumber(Math.round(row.tokensPerSecond))} token/秒
      </div>
    </div>
  );
}

function ApiKeysSection({
  apiKeys,
  channels,
  onCreated,
  onDeleted,
  onUpdated,
}: {
  apiKeys: PublicApiKey[];
  channels: ChannelRecord[];
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
                        : formatTokenNumber(apiKey.tokenLimitDaily)}
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
        channels={channels}
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
        channels={channels}
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
  channels,
  mode,
  onOpenChange,
  onSaved,
  open,
}: {
  apiKey?: PublicApiKey | null;
  channels: ChannelRecord[];
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSaved: (apiKey: PublicApiKey | CreatedApiKey) => void;
  open: boolean;
}) {
  const initialForm =
    mode === "edit" && apiKey ? apiKeyToForm(apiKey) : EMPTY_API_KEY_FORM;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {open && (
          <ApiKeyFormDialogBody
            key={`${mode}:${apiKey?.id || "new"}`}
            apiKey={apiKey}
            channels={channels}
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
  channels,
  initialForm,
  mode,
  onCancel,
  onSaved,
}: {
  apiKey?: PublicApiKey | null;
  channels: ChannelRecord[];
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
      <ApiKeyFields channels={channels} form={form} onChange={setForm} />
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
  channels,
  form,
  onChange,
}: {
  channels: ChannelRecord[];
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
          <FieldLabel>通道白名单</FieldLabel>
          <ChannelVisualSelector
            channels={channels}
            emptyLabel="不限通道"
            selectedIds={parseList(form.channelAllowlist)}
            onSelectedIdsChange={(ids) =>
              update("channelAllowlist", ids.join("\n"))
            }
          />
          <FieldDescription>
            不选任何通道表示这个密钥可以使用所有可用通道。
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

function CredentialVisualSelector({
  credentials,
  onSelectedIdsChange,
  selectedIds,
}: {
  credentials: CodexCredentialRecord[];
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const selectedIdSet = new Set(selectedIds);

  function toggleCredential(id: string) {
    onSelectedIdsChange(
      selectedIdSet.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  if (credentials.length === 0) {
    return (
      <Alert>
        <UserRoundIcon />
        <AlertTitle>暂无可选凭据</AlertTitle>
        <AlertDescription>请先连接或上传 Codex 凭据。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {credentials.map((credential) => {
        const selected = selectedIdSet.has(credential.id);
        const name = credential.email || credential.accountId || credential.id;
        return (
          <Button
            key={credential.id}
            type="button"
            variant={selected ? "secondary" : "outline"}
            className="h-auto justify-start whitespace-normal p-3 text-left"
            onClick={() => toggleCredential(credential.id)}
          >
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {selected ? (
                    <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
                  ) : (
                    <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-medium">{name}</span>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {codexPlanLabel(credential.planType)}
                </Badge>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div className="truncate font-mono">{credential.id}</div>
                <div>
                  优先级 {formatNumber(credential.priority)} · 权重{" "}
                  {formatNumber(credential.weight)} · 健康度{" "}
                  {formatNumber(usageHealthScore(credential.usageHealth))}%
                </div>
              </div>
            </div>
          </Button>
        );
      })}
    </div>
  );
}

function ChannelVisualSelector({
  channels,
  emptyLabel,
  onSelectedIdsChange,
  selectedIds,
}: {
  channels: ChannelRecord[];
  emptyLabel: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const uniqueChannels = uniqueChannelsById(channels);
  const selectedIdSet = new Set(selectedIds);
  const unrestricted = selectedIds.length === 0;

  function toggleChannel(id: string) {
    onSelectedIdsChange(
      selectedIdSet.has(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  if (uniqueChannels.length === 0) {
    return (
      <Alert>
        <RouteIcon />
        <AlertTitle>暂无可选通道</AlertTitle>
        <AlertDescription>请先创建或导入通道。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant={unrestricted ? "secondary" : "outline"}
        className="h-auto justify-start p-3 text-left"
        onClick={() => onSelectedIdsChange([])}
      >
        <div className="flex min-w-0 items-center gap-2">
          {unrestricted ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
          ) : (
            <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div>
            <div className="font-medium">{emptyLabel}</div>
            <div className="text-xs text-muted-foreground">
              Relay 会在所有可用通道中自动路由。
            </div>
          </div>
        </div>
      </Button>

      <div className="grid gap-2 sm:grid-cols-2">
        {uniqueChannels.map((channel, index) => {
          const selected = selectedIdSet.has(channel.id);
          return (
            <Button
              key={`${channel.id}:${index}`}
              type="button"
              variant={selected ? "secondary" : "outline"}
              className="h-auto justify-start whitespace-normal p-3 text-left"
              onClick={() => toggleChannel(channel.id)}
            >
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {selected ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
                    ) : (
                      <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{channel.name}</span>
                  </div>
                  {renderChannelStatusBadge(channel.status)}
                </div>
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <div className="truncate font-mono">{channel.id}</div>
                  <div>
                    优先级 {formatNumber(channel.priority)} · 权重{" "}
                    {formatNumber(channel.weight)} · 凭据{" "}
                    {formatNumber(channel.credentialIds.length)} · 健康度{" "}
                    {formatNumber(channel.healthScore)}%
                  </div>
                </div>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
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

function ProxyPoolSection({
  proxyPool,
  onChanged,
}: {
  proxyPool: ProxyPoolRecord[];
  onChanged: (proxyPool: ProxyPoolRecord[]) => void;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProxyPoolRecord | null>(null);
  const [form, setForm] = React.useState<ProxyPoolFormState>(() =>
    emptyProxyPoolForm(),
  );
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  function patchForm(patch: Partial<ProxyPoolFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyProxyPoolForm());
    setDialogOpen(true);
  }

  function openEdit(proxy: ProxyPoolRecord) {
    setEditing(proxy);
    setForm(proxyPoolForm(proxy));
    setDialogOpen(true);
  }

  async function refreshProxyPool() {
    onChanged(await listProxyPoolItems());
  }

  async function saveProxy() {
    const payload = proxyPoolPayload(form, editing);
    if (!payload) {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateProxyPoolItem(editing.id, payload);
        onChanged([
          updated,
          ...proxyPool.filter((proxy) => proxy.id !== updated.id),
        ]);
        toast.success("代理已更新");
      } else {
        const created = await createProxyPoolItem(payload);
        onChanged([created, ...proxyPool]);
        toast.success("代理已添加");
      }
      setDialogOpen(false);
      setEditing(null);
      setForm(emptyProxyPoolForm());
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeProxy(proxy: ProxyPoolRecord) {
    setPendingId(proxy.id);
    try {
      await deleteProxyPoolItem(proxy.id);
      onChanged(proxyPool.filter((item) => item.id !== proxy.id));
      toast.success("代理已删除");
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
          <CardTitle>代理池</CardTitle>
          <CardDescription>
            集中保存 SOCKS5 / SOCKS5H 代理账密，之后可在 Codex
            凭据设置中直接选择使用。
          </CardDescription>
          <CardAction>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={refreshProxyPool}
              >
                <RefreshCwIcon data-icon="inline-start" />
                刷新
              </Button>
              <Button type="button" onClick={openCreate}>
                <PlusIcon data-icon="inline-start" />
                添加代理
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {proxyPool.length === 0 ? (
            <Empty className="min-h-64">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DatabaseIcon />
                </EmptyMedia>
                <EmptyTitle>还没有代理</EmptyTitle>
                <EmptyDescription>
                  添加代理后，可以在凭据设置里下拉选择，不用重复输入账密。
                </EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={openCreate}>
                <PlusIcon data-icon="inline-start" />
                添加代理
              </Button>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>地址</TableHead>
                    <TableHead>认证</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最近使用</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proxyPool.map((proxy) => (
                    <TableRow key={proxy.id}>
                      <TableCell>
                        <div className="grid gap-1">
                          <span className="font-medium">{proxy.name}</span>
                          {proxy.notes && (
                            <span className="text-xs text-muted-foreground">
                              {proxy.notes}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {proxy.type}://{proxy.host}:{proxy.port}
                      </TableCell>
                      <TableCell>
                        {proxy.username ? (
                          <Badge variant="outline">
                            {proxy.username}
                            {proxy.passwordSet ? ":******" : ""}
                          </Badge>
                        ) : (
                          <Badge variant="outline">无用户名</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={proxy.enabled ? "secondary" : "outline"}
                        >
                          {proxy.enabled ? "已启用" : "已停用"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {formatNullableDate(proxy.lastUsedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pendingId === proxy.id}
                            onClick={() => openEdit(proxy)}
                          >
                            <PencilIcon data-icon="inline-start" />
                            编辑
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pendingId === proxy.id}
                            onClick={() => removeProxy(proxy)}
                          >
                            {pendingId === proxy.id ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Trash2Icon data-icon="inline-start" />
                            )}
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑代理" : "添加代理"}</DialogTitle>
            <DialogDescription>
              密码会在服务端加密保存，前端列表不会返回明文。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input
                disabled={saving}
                value={form.name}
                placeholder="香港 GOST 01"
                onChange={(event) => patchForm({ name: event.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-[0.8fr_1fr_0.7fr]">
              <Field>
                <FieldLabel>协议</FieldLabel>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving}
                  value={form.type}
                  onChange={(event) =>
                    patchForm({
                      type: event.target.value as CredentialProxyType,
                    })
                  }
                >
                  <option value="socks5h">socks5h</option>
                  <option value="socks5">socks5</option>
                </select>
              </Field>
              <Field>
                <FieldLabel>主机</FieldLabel>
                <Input
                  disabled={saving}
                  value={form.host}
                  placeholder="127.0.0.1"
                  onChange={(event) => patchForm({ host: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>端口</FieldLabel>
                <Input
                  disabled={saving}
                  inputMode="numeric"
                  value={form.port}
                  placeholder="1080"
                  onChange={(event) => patchForm({ port: event.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>用户名（可选）</FieldLabel>
                <Input
                  disabled={saving}
                  value={form.username}
                  placeholder="username"
                  onChange={(event) =>
                    patchForm({ username: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel>密码（留空保持原密码）</FieldLabel>
                <Input
                  disabled={saving}
                  type="password"
                  value={form.password}
                  placeholder={
                    editing?.passwordSet ? "已设置，留空保持不变" : "password"
                  }
                  onChange={(event) =>
                    patchForm({ password: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>备注</FieldLabel>
              <Textarea
                disabled={saving}
                value={form.notes}
                placeholder="可选备注"
                onChange={(event) => patchForm({ notes: event.target.value })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>启用代理</FieldLabel>
                <FieldDescription>
                  停用后引用它的凭据会继续回退到全局代理或直连。
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={form.enabled}
                disabled={saving}
                onCheckedChange={(checked) =>
                  patchForm({ enabled: Boolean(checked) })
                }
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={saveProxy}>
              {saving && <Spinner data-icon="inline-start" />}
              保存代理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CredentialsSection({
  credentials,
  globalSettings,
  proxyPool,
  onDeleted,
  onRefreshData,
  onUpdated,
}: {
  credentials: CodexCredentialRecord[];
  globalSettings: GlobalSettingsRecord;
  proxyPool: ProxyPoolRecord[];
  onDeleted: (id: string) => void;
  onRefreshData: () => Promise<{
    credentials: CodexCredentialRecord[];
    channels: ChannelRecord[];
  }>;
  onUpdated: (credential: CodexCredentialRecord) => void;
}) {
  const [oauthOpen, setOauthOpen] = React.useState(false);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [uploadingCredential, setUploadingCredential] = React.useState(false);
  const [exportingCredentials, setExportingCredentials] = React.useState(false);
  const credentialFileInputRef = React.useRef<HTMLInputElement>(null);
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
      throw error;
    } finally {
      setPendingId(null);
    }
  }

  const loadQuota = React.useCallback(
    async (
      credential: CodexCredentialRecord,
      options: { forceRefresh?: boolean; silent?: boolean } = {},
    ) => {
      const forceRefresh = options.forceRefresh ?? false;
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
      void loadQuota(credential, { forceRefresh: false, silent: true });
    });
  }, [credentials, loadQuota]);

  const quotaRefreshPending = refreshingAllQuotas || quotaLoadingIds.size > 0;
  const sortedCredentials = React.useMemo(
    () =>
      [...credentials].sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          right.priority - left.priority ||
          usageHealthScore(right.usageHealth) -
            usageHealthScore(left.usageHealth) ||
          codexPlanRank(right.planType) - codexPlanRank(left.planType),
      ),
    [credentials],
  );

  function openCredentialUpload() {
    credentialFileInputRef.current?.click();
  }

  async function handleCredentialUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    setUploadingCredential(true);
    try {
      const importedCredentials: CodexCredentialRecord[] = [];
      let failedCount = 0;

      for (const file of files) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await file.text()) as unknown;
        } catch (error) {
          failedCount += 1;
          console.error(`Failed to parse credential file ${file.name}`, error);
          continue;
        }

        const payloads = credentialUploadPayloads(parsed);
        if (payloads.length === 0) {
          failedCount += 1;
          continue;
        }

        for (const [index, payload] of payloads.entries()) {
          try {
            const imported = await importCredentialJson(
              payload,
              payloads.length > 1 ? `${file.name}#${index + 1}` : file.name,
            );
            importedCredentials.push(imported);
            quotaLoadRequestedRef.current.add(imported.id);
          } catch (error) {
            failedCount += 1;
            console.error(
              `Failed to import credential from ${file.name}#${index + 1}`,
              error,
            );
          }
        }
      }

      if (importedCredentials.length > 0) {
        await onRefreshData();
        importedCredentials.forEach((credential) => {
          void loadQuota(credential, { forceRefresh: false, silent: true });
        });
      }

      if (importedCredentials.length > 0 && failedCount > 0) {
        toast.error(
          `已上传 ${formatNumber(importedCredentials.length)} 个，失败 ${formatNumber(failedCount)} 个`,
        );
      } else if (importedCredentials.length > 0) {
        toast.success(
          `已上传 ${formatNumber(importedCredentials.length)} 个 Codex 凭据`,
        );
      } else {
        toast.error("没有成功上传的 Codex 凭据");
      }
    } finally {
      setUploadingCredential(false);
    }
  }

  async function exportAllCredentials() {
    setExportingCredentials(true);
    try {
      await downloadCredentialsExport();
      toast.success("Codex 凭据导出已开始");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setExportingCredentials(false);
    }
  }

  async function remove(credential: CodexCredentialRecord) {
    setPendingId(credential.id);
    try {
      await deleteCredential(credential.id);
      onDeleted(credential.id);
      toast.success("Codex 凭据已删除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
      throw error;
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <input
        ref={credentialFileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        multiple
        onChange={handleCredentialUploadChange}
      />

      <Card>
        <CardHeader>
          <CardTitle>Codex 凭据</CardTitle>
          <CardDescription>
            连接 Codex 账号、刷新 token、查看额度。日常列表不会返回 token
            明文；显式导出备份会下载包含 token 明文的 JSON。
          </CardDescription>
          <CardAction>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={credentials.length === 0 || exportingCredentials}
                onClick={exportAllCredentials}
              >
                {exportingCredentials ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                导出全部
              </Button>
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
              <Button
                type="button"
                variant="outline"
                disabled={uploadingCredential}
                onClick={openCredentialUpload}
              >
                {uploadingCredential ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <UploadIcon data-icon="inline-start" />
                )}
                上传凭证
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
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploadingCredential}
                  onClick={openCredentialUpload}
                >
                  {uploadingCredential ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <UploadIcon data-icon="inline-start" />
                  )}
                  上传凭证
                </Button>
                <Button type="button" onClick={() => setOauthOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  连接 Codex
                </Button>
              </div>
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {sortedCredentials.map((credential) => {
                const quota = quotas[credential.id];
                const quotaLoading = quotaLoadingIds.has(credential.id);
                const name =
                  credential.email || credential.accountId || "未知账号";
                const refreshStatus = codexTokenRefreshStatus(credential);

                return (
                  <Card
                    key={credential.id}
                    className="relative bg-linear-to-br from-card via-card to-muted/45 shadow-sm"
                  >
                    <CardContent className="grid gap-3">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <Badge
                            variant="outline"
                            className={`h-6 shrink-0 px-2 text-sm font-semibold ${codexPlanBadgeTone(credential.planType)}`}
                          >
                            {codexPlanLabel(credential.planType)}
                          </Badge>
                          <div
                            className="min-w-0 flex-1 truncate text-base font-medium"
                            title={name}
                          >
                            {name}
                          </div>
                        </div>
                        <div className="flex shrink-0 justify-end gap-1.5">
                          <CredentialSettingsDialog
                            credential={credential}
                            disabled={pendingId === credential.id}
                            onDeleted={() => remove(credential)}
                            onRefreshToken={() => refreshToken(credential)}
                            onSaved={onUpdated}
                            proxyPool={proxyPool}
                          />
                        </div>
                      </div>

                      {(refreshStatus.exhausted ||
                        refreshStatus.attemptCount > 0 ||
                        refreshStatus.autoDisabled ||
                        !credential.enabled) && (
                        <div className="flex flex-wrap gap-1.5">
                          {!credential.enabled && (
                            <Badge variant="outline">
                              {refreshStatus.autoDisabled
                                ? "自动停用"
                                : "已停用"}
                            </Badge>
                          )}
                          {refreshStatus.exhausted ? (
                            <Badge variant="destructive">Token 刷新错误</Badge>
                          ) : refreshStatus.attemptCount > 0 ? (
                            <Badge variant="outline">
                              Token 刷新{" "}
                              {formatNumber(refreshStatus.attemptCount)}
                              /3
                            </Badge>
                          ) : null}
                        </div>
                      )}

                      <div className="grid gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-muted-foreground">
                            凭据健康度：
                          </span>
                          {credential.usageHealth ? (
                            <>
                              <UsageHealthBadge
                                status={credential.usageHealth.status}
                              />
                              <span className="tabular-nums text-muted-foreground">
                                {formatNumber(credential.usageHealth.score)}%
                              </span>
                            </>
                          ) : (
                            <Badge variant="outline">未知</Badge>
                          )}
                        </div>
                        {credential.usageHealth && (
                          <div className="text-xs text-muted-foreground">
                            最近{" "}
                            {formatNumber(credential.usageHealth.windowSize)} 次
                            · 成功{" "}
                            {formatNumber(credential.usageHealth.successCount)}{" "}
                            · 错误{" "}
                            {formatNumber(credential.usageHealth.errorCount)}
                          </div>
                        )}
                        {credential.cooldownUntil && (
                          <div className="text-xs text-amber-600 dark:text-amber-300">
                            凭据冷却至{" "}
                            {formatNullableDate(credential.cooldownUntil)}
                          </div>
                        )}
                        {refreshStatus.hasNotice && (
                          <div
                            className={
                              refreshStatus.exhausted
                                ? "text-xs text-destructive"
                                : "text-xs text-amber-600 dark:text-amber-300"
                            }
                          >
                            {refreshStatus.exhausted ? (
                              <>
                                {refreshStatus.autoDisabled
                                  ? "Token 自动刷新已连续失败 3 次，凭据已自动停用。"
                                  : "Token 自动刷新已连续失败 3 次。"}
                              </>
                            ) : (
                              <>
                                Token 自动刷新失败{" "}
                                {formatNumber(refreshStatus.attemptCount)}/3
                                {refreshStatus.nextAttemptAt && (
                                  <>
                                    ，下次尝试：
                                    <LocalDateTime
                                      value={refreshStatus.nextAttemptAt}
                                    />
                                  </>
                                )}
                              </>
                            )}
                            {refreshStatus.lastError && (
                              <>。原因：{refreshStatus.lastError}</>
                            )}
                          </div>
                        )}
                        {credential.lastError && !refreshStatus.hasNotice && (
                          <div className="text-xs text-destructive">
                            {credential.lastError}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          请求代理：
                        </span>
                        <CredentialProxyBadge
                          credential={credential}
                          globalSettings={globalSettings}
                          proxyPool={proxyPool}
                        />
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
                    {refreshingAllQuotas && quotaLoading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70 backdrop-blur-[1px]">
                        <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-sm font-medium shadow-sm">
                          <Spinner data-icon="inline-start" />
                          刷新额度中
                        </div>
                      </div>
                    )}
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

function CredentialRoutingControls({
  credential,
  disabled,
  onSaved,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
}) {
  const [priority, setPriority] = React.useState(
    credential.priority.toString(),
  );
  const [weight, setWeight] = React.useState(credential.weight.toString());
  const [saving, setSaving] = React.useState(false);

  const fastAvailable = isFastCredentialPlan(credential.planType);

  async function saveRouting(patch: {
    enabled?: boolean;
    priority?: number;
    weight?: number;
    fastEnabled?: boolean;
    upstreamTransport?: CodexUpstreamTransport;
  }) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, patch);
      onSaved(updated);
      toast.success("凭据路由配置已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">凭据路由</div>
        </div>
        <Switch
          checked={credential.enabled}
          disabled={disabled || saving}
          size="sm"
          onCheckedChange={(checked) =>
            saveRouting({ enabled: Boolean(checked) })
          }
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">Fast</div>
            <div className="text-xs text-muted-foreground">
              Pro / Pro 20x 可用
            </div>
          </div>
          <Switch
            checked={credential.fastEnabled && fastAvailable}
            disabled={disabled || saving || !fastAvailable}
            size="sm"
            onCheckedChange={(checked) =>
              saveRouting({ fastEnabled: Boolean(checked) })
            }
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">WebSocket</div>
            <div className="text-xs text-muted-foreground">流式 /responses</div>
          </div>
          <Switch
            checked={credential.upstreamTransport === "websocket"}
            disabled={disabled || saving}
            size="sm"
            onCheckedChange={(checked) =>
              saveRouting({
                upstreamTransport: checked ? "websocket" : "http",
              })
            }
          />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input
          aria-label="凭据优先级"
          inputMode="numeric"
          value={priority}
          placeholder="优先级"
          onChange={(event) => setPriority(event.target.value)}
        />
        <Input
          aria-label="凭据权重"
          inputMode="numeric"
          value={weight}
          placeholder="权重"
          onChange={(event) => setWeight(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || saving}
          onClick={() =>
            saveRouting({
              priority: integerValue(priority, credential.priority),
              weight: Math.max(1, integerValue(weight, credential.weight)),
            })
          }
        >
          {saving && <Spinner data-icon="inline-start" />}
          保存
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        当前：优先级 {formatNumber(credential.priority)} · 权重{" "}
        {formatNumber(credential.weight)} · Fast{" "}
        {credential.fastEnabled && fastAvailable ? "开" : "关"} ·{" "}
        {credentialUpstreamTransportText(credential.upstreamTransport)}
      </div>
    </div>
  );
}

function CredentialUserAgentControls({
  credential,
  disabled,
  onSaved,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
}) {
  const [value, setValue] = React.useState(credential.userAgent ?? "");
  const [saving, setSaving] = React.useState(false);

  async function saveUserAgent(userAgent: string | null) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        userAgent,
      });
      onSaved(updated);
      setValue(updated.userAgent ?? "");
      toast.success(
        updated.userAgent
          ? "凭据 User-Agent 已保存"
          : "凭据 User-Agent 已清除，将使用全局设置",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const pending = disabled || saving;

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <div className="font-medium">User-Agent 覆盖</div>
          <div className="text-xs text-muted-foreground">
            留空则使用全局设置。该值会用于此凭据的 Codex 请求和额度刷新。
          </div>
        </div>
        <Badge variant={credential.userAgent ? "secondary" : "outline"}>
          {credential.userAgent ? "凭据自定义" : "使用全局"}
        </Badge>
      </div>
      <Textarea
        className="min-h-20 font-mono text-xs"
        disabled={pending}
        value={value}
        placeholder="使用全局 User-Agent"
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          当前：{credential.userAgent || "使用全局 User-Agent"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !credential.userAgent}
            onClick={() => saveUserAgent(null)}
          >
            {saving && <Spinner data-icon="inline-start" />}
            清除覆盖
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => saveUserAgent(value.trim() || null)}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存 User-Agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function CredentialProxyControls({
  credential,
  disabled,
  onSaved,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onSaved: (credential: CodexCredentialRecord) => void;
  proxyPool: ProxyPoolRecord[];
}) {
  const [form, setForm] = React.useState(() => credentialProxyForm(credential));
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const proxy = credential.proxy;

  function patchForm(patch: Partial<CredentialProxyFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function saveProxy() {
    const host = form.host.trim();
    const port = integerValue(form.port, 0);
    if (!host) {
      toast.error("请输入 SOCKS5 代理主机");
      return;
    }
    if (port < 1 || port > 65535) {
      toast.error("代理端口必须在 1 到 65535 之间");
      return;
    }

    setSaving(true);
    try {
      const payload: {
        enabled: boolean;
        type: CredentialProxyType;
        host: string;
        port: number;
        username: string;
        password?: string;
      } = {
        enabled: form.enabled,
        type: form.type,
        host,
        port,
        username: form.username.trim(),
      };
      if (form.password.trim()) {
        payload.password = form.password;
      }
      const updated = await updateCredentialRouting(credential.id, {
        proxy: payload,
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("凭据请求代理已保存");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearProxy() {
    setClearing(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxy: null,
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("凭据请求代理已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  async function saveProxyPoolId(proxyPoolId: string | null) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxyPoolId,
      });
      onSaved(updated);
      toast.success(proxyPoolId ? "已选择代理池代理" : "代理池选择已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUseGlobalProxy(useGlobalProxy: boolean) {
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        useGlobalProxy,
      });
      onSaved(updated);
      toast.success(
        useGlobalProxy ? "已允许使用全局代理" : "已关闭全局代理回退",
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    if (!proxy) {
      return;
    }
    setSaving(true);
    try {
      const updated = await updateCredentialRouting(credential.id, {
        proxy: {
          enabled: proxy.enabled,
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: "",
        },
      });
      setForm(credentialProxyForm(updated));
      onSaved(updated);
      toast.success("代理密码已清除");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const pending = disabled || saving || clearing;

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">请求代理</div>
        </div>
        <Switch
          checked={form.enabled}
          disabled={pending}
          size="sm"
          onCheckedChange={(checked) =>
            patchForm({ enabled: Boolean(checked) })
          }
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 p-2">
          <div>
            <div className="font-medium">使用全局代理</div>
            <div className="text-xs text-muted-foreground">
              无本地/代理池代理时回退
            </div>
          </div>
          <Switch
            checked={credential.useGlobalProxy}
            disabled={pending}
            size="sm"
            onCheckedChange={(checked) => saveUseGlobalProxy(Boolean(checked))}
          />
        </div>
        <label className="grid gap-1 rounded-md border border-border/50 bg-background/50 p-2 text-xs text-muted-foreground">
          代理池
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            value={credential.proxyPoolId ?? ""}
            onChange={(event) =>
              saveProxyPoolId(event.target.value ? event.target.value : null)
            }
          >
            <option value="">不使用代理池</option>
            {proxyPool.map((proxy) => (
              <option key={proxy.id} value={proxy.id}>
                {proxy.name} · {proxy.type}://{proxy.host}:{proxy.port}
                {proxy.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-[0.8fr_1fr_0.7fr]">
        <label className="grid gap-1 text-xs text-muted-foreground">
          协议
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            value={form.type}
            onChange={(event) =>
              patchForm({ type: event.target.value as CredentialProxyType })
            }
          >
            <option value="socks5h">socks5h</option>
            <option value="socks5">socks5</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          主机
          <Input
            disabled={pending}
            value={form.host}
            placeholder="127.0.0.1"
            onChange={(event) => patchForm({ host: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          端口
          <Input
            disabled={pending}
            inputMode="numeric"
            value={form.port}
            placeholder="1080"
            onChange={(event) => patchForm({ port: event.target.value })}
          />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          用户名（可选）
          <Input
            disabled={pending}
            value={form.username}
            placeholder="username"
            onChange={(event) => patchForm({ username: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          密码（留空则保持原密码）
          <Input
            disabled={pending}
            type="password"
            value={form.password}
            placeholder={
              proxy?.passwordSet ? "已设置，留空保持不变" : "password"
            }
            onChange={(event) => patchForm({ password: event.target.value })}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          当前：{credentialProxyText(credential)} · 代理池：
          {proxyPoolSelectionText(credential, proxyPool)} · 全局：
          {credential.useGlobalProxy ? "开启" : "关闭"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !proxy?.passwordSet}
            onClick={clearPassword}
          >
            {saving && <Spinner data-icon="inline-start" />}
            清除密码
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !proxy}
            onClick={clearProxy}
          >
            {clearing && <Spinner data-icon="inline-start" />}
            清除代理
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={saveProxy}
          >
            {saving && <Spinner data-icon="inline-start" />}
            保存代理
          </Button>
        </div>
      </div>
    </div>
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

function CredentialSettingsDialog({
  credential,
  disabled,
  onDeleted,
  onRefreshToken,
  onSaved,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  disabled: boolean;
  onDeleted: () => Promise<void>;
  onRefreshToken: () => Promise<void>;
  onSaved: (credential: CodexCredentialRecord) => void;
  proxyPool: ProxyPoolRecord[];
}) {
  const [open, setOpen] = React.useState(false);
  const [refreshingToken, setRefreshingToken] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const accountName = credential.email || credential.accountId || credential.id;

  async function refreshTokenFromSettings() {
    setRefreshingToken(true);
    try {
      await onRefreshToken();
    } catch {
      // Parent action already shows the concrete error toast.
    } finally {
      setRefreshingToken(false);
    }
  }

  async function exportCredentialFromSettings() {
    setExporting(true);
    try {
      await downloadCredentialsExport(credential.id);
      toast.success("Codex 凭据导出已开始");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="凭据设置"
      >
        <SettingsIcon />
      </Button>
      <DialogContent className="max-h-[88vh] gap-3 overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="pr-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <DialogTitle>凭据设置</DialogTitle>
              <DialogDescription className="mt-1 truncate">
                {accountName}
              </DialogDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {codexPlanLabel(credential.planType)}
              </Badge>
              <Badge variant={credential.enabled ? "secondary" : "outline"}>
                {credential.enabled ? "已启用" : "已禁用"}
              </Badge>
              <Badge variant="outline">
                {credentialUpstreamTransportText(credential.upstreamTransport)}
              </Badge>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="grid h-fit gap-3">
            <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium" title={accountName}>
                  {accountName}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {credential.id}
                </div>
              </div>
              <div className="grid gap-1.5 text-xs text-muted-foreground">
                <CredentialCompactRow label="邮箱" value={credential.email} />
                <CredentialCompactRow
                  label="账号"
                  value={credential.accountId}
                />
                <CredentialCompactRow
                  label="过期"
                  value={formatNullableDate(credential.expiresAt)}
                />
                <CredentialCompactRow
                  label="使用"
                  value={formatNullableDate(credential.lastUsedAt)}
                />
              </div>
            </div>

            <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 p-2.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-start"
                disabled={disabled || refreshingToken}
                onClick={refreshTokenFromSettings}
              >
                {refreshingToken ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新 token
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-start"
                disabled={disabled || exporting}
                onClick={exportCredentialFromSettings}
              >
                {exporting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                导出凭据
              </Button>
              <CredentialDeleteSettingsAction
                credential={credential}
                disabled={disabled}
                onConfirm={onDeleted}
              />
            </div>
          </aside>

          <section className="grid min-w-0 gap-3">
            <CredentialRoutingControls
              key={`${credential.id}:${credential.priority}:${credential.weight}:${credential.enabled}:${credential.fastEnabled}:${credential.upstreamTransport}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
            />

            <CredentialUserAgentControls
              key={`${credential.id}:${credential.userAgent ?? "global"}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
            />

            <CredentialProxyControls
              key={`${credential.id}:${credential.proxyPoolId}:${credential.proxy?.enabled}:${credential.proxy?.type}:${credential.proxy?.host}:${credential.proxy?.port}:${credential.proxy?.username}:${credential.proxy?.passwordSet}`}
              credential={credential}
              disabled={disabled}
              onSaved={onSaved}
              proxyPool={proxyPool}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function codexTokenRefreshStatus(credential: CodexCredentialRecord) {
  const attemptCount = metadataInteger(
    credential.metadata.token_refresh_attempt_count,
  );
  const exhausted = credential.metadata.token_refresh_exhausted === true;
  const autoDisabled = credential.metadata.token_refresh_auto_disabled === true;
  const nextAttemptAt = metadataString(
    credential.metadata.token_refresh_next_attempt_at,
  );
  const lastError =
    metadataString(credential.metadata.token_refresh_last_error) ||
    (exhausted ? credential.lastError || "" : "");
  return {
    attemptCount,
    exhausted,
    autoDisabled,
    nextAttemptAt,
    lastError,
    hasNotice: exhausted || attemptCount > 0,
  };
}

function CredentialProxyBadge({
  credential,
  globalSettings,
  proxyPool,
}: {
  credential: CodexCredentialRecord;
  globalSettings: GlobalSettingsRecord;
  proxyPool: ProxyPoolRecord[];
}) {
  const proxy = credential.proxy;
  if (proxy?.enabled) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        title={credentialProxyText(credential)}
      >
        已启用 · {proxy.type}
      </Badge>
    );
  }

  if (credential.proxyPoolId) {
    const pooledProxy = proxyPool.find(
      (proxy) => proxy.id === credential.proxyPoolId,
    );
    if (!pooledProxy) {
      return (
        <Badge variant="outline" title="已选择代理池代理，但该代理不存在">
          代理池 · 缺失
        </Badge>
      );
    }
    return (
      <Badge variant="outline" title={proxyPoolRecordText(pooledProxy)}>
        代理池 · {pooledProxy.enabled ? "已启用" : "已停用"} ·{" "}
        {pooledProxy.type}
      </Badge>
    );
  }

  if (credential.useGlobalProxy) {
    const globalProxy = globalSettings.proxy;
    if (!globalProxy) {
      return (
        <Badge
          variant="outline"
          className="border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          title="已开启全局代理回退，但当前未配置全局代理"
        >
          全局代理 · 未配置
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className={
          globalProxy.enabled
            ? "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "border-border bg-muted/60 text-muted-foreground"
        }
        title={`全局代理（${globalProxySourceLabel(globalSettings.proxySource)}）：${globalProxyText(globalSettings)}`}
      >
        全局代理 · {globalProxy.enabled ? "已启用" : "已停用"} ·{" "}
        {globalProxy.type}
      </Badge>
    );
  }

  if (proxy) {
    return (
      <Badge
        variant="outline"
        className="border-border bg-muted/60 text-muted-foreground"
        title={credentialProxyText(credential)}
      >
        已停用 · {proxy.type}
      </Badge>
    );
  }

  return <Badge variant="outline">未配置</Badge>;
}

function CredentialCompactRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="shrink-0">{label}</span>
      <span
        className="min-w-0 truncate text-right font-medium text-foreground"
        title={typeof value === "string" ? value : undefined}
      >
        {value || "-"}
      </span>
    </div>
  );
}

function CredentialDeleteSettingsAction({
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
    } catch {
      // Parent action already shows the concrete error toast.
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
        className="justify-start"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" />
        删除凭据
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>删除 Codex 凭据？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除 {credential.email || credential.accountId || credential.id}
            。此操作不可恢复。
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
  const uniqueChannels = uniqueChannelsById(channels);

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
            会先过滤已禁用、冷却中、凭据缺失和模型不匹配的通道；通道健康度取最近
            100 次请求成功率，凭据健康度取最近 50
            次请求成功率。路由先按健康度分层，再按优先级和权重加权选择。
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
            {uniqueChannels.length === 0 ? (
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
                  {uniqueChannels.map((channel, index) => {
                    const channelCredentials = channel.credentialIds
                      .map((credentialId) => credentialsById.get(credentialId))
                      .filter(Boolean) as CodexCredentialRecord[];
                    return (
                      <TableRow key={`${channel.id}:${index}`}>
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
                          {channelCredentials.length > 0 ? (
                            <div className="grid gap-1">
                              {channelCredentials
                                .slice(0, 2)
                                .map((credential, index) => (
                                  <div
                                    key={`${credential.id}:${index}`}
                                    className="truncate"
                                  >
                                    {credential.email ||
                                      credential.accountId ||
                                      credential.id}
                                  </div>
                                ))}
                              {channelCredentials.length > 2 && (
                                <div className="text-xs text-muted-foreground">
                                  +{formatNumber(channelCredentials.length - 2)}{" "}
                                  个凭据
                                </div>
                              )}
                            </div>
                          ) : (
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
                              <span>
                                最近{" "}
                                {formatNumber(
                                  channel.usageHealth?.windowSize || 100,
                                )}{" "}
                                次
                              </span>
                              <span className="tabular-nums">
                                {formatNumber(channel.healthScore)}%
                              </span>
                            </div>
                            <Progress
                              value={clamp(channel.healthScore, 0, 100)}
                            />
                            {channel.usageHealth && (
                              <div className="text-xs text-muted-foreground">
                                成功{" "}
                                {formatNumber(channel.usageHealth.successCount)}{" "}
                                · 错误{" "}
                                {formatNumber(channel.usageHealth.errorCount)}
                              </div>
                            )}
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
          credentialIds: credentials[0]?.id || "",
        };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
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
    if (parseList(form.credentialIds).length === 0) {
      toast.error("请至少选择一个 Codex 凭据");
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
          <FieldLabel>绑定凭据</FieldLabel>
          <CredentialVisualSelector
            credentials={credentials}
            selectedIds={parseList(form.credentialIds)}
            onSelectedIdsChange={(ids) =>
              update("credentialIds", ids.join("\n"))
            }
          />
          <FieldDescription>
            可选择多个凭据。通道内会按凭据优先级、权重和健康度自动选择实际发送请求的凭据。
          </FieldDescription>
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
  initialRequestLogsPage,
  onLoaded,
}: {
  initialRequestLogsPage: RequestLogsPage;
  onLoaded: (logs: AdminDashboardRequestLogRow[]) => void;
}) {
  const [logsPage, setLogsPage] = React.useState<RequestLogsPage>(
    initialRequestLogsPage,
  );
  const [queryInput, setQueryInput] = React.useState("");
  const [activeQuery, setActiveQuery] = React.useState("");
  const [statusFilter, setStatusFilter] =
    React.useState<LogStatusFilter>("all");
  const [pageSize, setPageSize] = React.useState(initialRequestLogsPage.limit);
  const [loading, setLoading] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [selectedDetail, setSelectedDetail] =
    React.useState<RequestLogDetail | null>(null);

  const totalPages = Math.max(1, logsPage.totalPages);
  const pageStart = logsPage.total > 0 ? logsPage.offset + 1 : 0;
  const pageEnd = Math.min(
    logsPage.offset + logsPage.data.length,
    logsPage.total,
  );

  async function loadLogs(
    input: {
      page?: number;
      limit?: number;
      query?: string;
      status?: LogStatusFilter;
      successMessage?: string;
    } = {},
  ) {
    const nextPage = input.page ?? logsPage.page;
    const nextLimit = input.limit ?? pageSize;
    const nextQuery = input.query ?? activeQuery;
    const nextStatus = input.status ?? statusFilter;
    setLoading(true);
    try {
      const result = await getRequestLogsPage({
        limit: nextLimit,
        page: nextPage,
        query: nextQuery,
        status: nextStatus,
      });
      setLogsPage(result);
      setActiveQuery(nextQuery);
      setQueryInput(nextQuery);
      setStatusFilter(nextStatus);
      setPageSize(nextLimit);
      onLoaded(result.data);
      if (input.successMessage) {
        toast.success(input.successMessage);
      }
      return result;
    } catch (error) {
      toast.error(adminErrorMessage(error));
      return null;
    } finally {
      setLoading(false);
    }
  }

  function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadLogs({ page: 1, query: queryInput });
  }

  async function openLogDetail(id: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      setSelectedDetail(await getRequestLogDetail(id));
    } catch (error) {
      toast.error(adminErrorMessage(error));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          title="匹配日志"
          value={formatNumber(logsPage.total)}
          description={
            logsPage.total > 0
              ? `第 ${formatNumber(logsPage.page)}/${formatNumber(totalPages)} 页 · ${formatNumber(pageStart)}-${formatNumber(pageEnd)}`
              : "没有匹配结果"
          }
          icon={FileTextIcon}
        />
        <MetricCard
          title="匹配错误"
          value={formatNumber(logsPage.summary.errorCount)}
          description={`错误率 ${formatPercent(ratio(logsPage.summary.errorCount, logsPage.total))}`}
          icon={AlertTriangleIcon}
          tone={logsPage.summary.errorCount > 0 ? "warning" : "success"}
        />
        <MetricCard
          title="匹配 Token"
          value={formatTokenNumber(logsPage.summary.totalTokens)}
          description={`缓存 ${formatTokenNumber(logsPage.summary.cachedTokens)} · 命中率 ${formatPercent(logsPage.summary.cacheHitRate)} · 平均延迟 ${formatDuration(logsPage.summary.avgLatencyMs)}`}
          icon={DatabaseIcon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>请求日志</CardTitle>
          <CardDescription>
            服务端分页查询全部请求日志，支持按状态和关键字搜索。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() =>
                void loadLogs({
                  page: logsPage.page,
                  successMessage: "请求日志已刷新",
                })
              }
            >
              {loading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新日志
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <form
              className="flex w-full flex-col gap-2 sm:flex-row xl:max-w-2xl"
              onSubmit={search}
            >
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  placeholder="搜索路径、模型、密钥、通道、凭据、错误、状态码..."
                  className="pl-8"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={loading}>
                  <SearchIcon data-icon="inline-start" />
                  搜索
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || (!activeQuery && !queryInput)}
                  onClick={() => void loadLogs({ page: 1, query: "" })}
                >
                  清空
                </Button>
              </div>
            </form>
            <div className="flex flex-wrap gap-2">
              {LOG_STATUS_FILTERS.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={statusFilter === item.id ? "secondary" : "outline"}
                  disabled={loading}
                  onClick={() => void loadLogs({ page: 1, status: item.id })}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

          {activeQuery && (
            <div className="text-sm text-muted-foreground">
              当前搜索：
              <span className="font-medium text-foreground">{activeQuery}</span>
            </div>
          )}

          {logsPage.total === 0 && !loading ? (
            <EmptyState
              icon={activeQuery ? SearchIcon : FileTextIcon}
              title={
                activeQuery || statusFilter !== "all"
                  ? "没有匹配的日志"
                  : "还没有请求日志"
              }
              description={
                activeQuery || statusFilter !== "all"
                  ? "调整关键字或状态筛选条件后再试。"
                  : "创建 API 密钥并调用 Relay 接口后，这里会展示全部请求日志。"
              }
            />
          ) : (
            <div className="grid gap-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>请求</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>首字延迟</TableHead>
                    <TableHead>密钥 / 通道</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logsPage.data.map((log) => (
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
                      <TableCell>
                        {formatNullableDuration(log.first_token_latency_ms)}
                      </TableCell>
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
                          {formatTokenNumber(log.total_tokens)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          输入 {formatTokenNumber(log.prompt_tokens)} / 输出{" "}
                          {formatTokenNumber(log.completion_tokens)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          缓存 {formatTokenNumber(log.cached_tokens)} ·{" "}
                          {formatPercent(log.cache_hit_rate)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void openLogDetail(log.id)}
                        >
                          <FileTextIcon data-icon="inline-start" />
                          详细
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="text-sm text-muted-foreground">
                  显示 {formatNumber(pageStart)}-{formatNumber(pageEnd)} / 共{" "}
                  {formatNumber(logsPage.total)} 条
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={pageSize}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    onChange={(event) =>
                      void loadLogs({
                        page: 1,
                        limit: Number.parseInt(event.target.value, 10),
                      })
                    }
                  >
                    {[25, 50, 100, 200].map((size) => (
                      <option key={size} value={size}>
                        每页 {size}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page <= 1}
                    onClick={() => void loadLogs({ page: 1 })}
                  >
                    首页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page <= 1}
                    onClick={() => void loadLogs({ page: logsPage.page - 1 })}
                  >
                    上一页
                  </Button>
                  <Badge variant="outline">
                    {formatNumber(logsPage.page)} / {formatNumber(totalPages)}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page >= totalPages}
                    onClick={() => void loadLogs({ page: logsPage.page + 1 })}
                  >
                    下一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page >= totalPages}
                    onClick={() => void loadLogs({ page: totalPages })}
                  >
                    末页
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <RequestLogDetailDialog
        open={detailOpen}
        loading={detailLoading}
        detail={selectedDetail}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

function RequestLogDetailDialog({
  open,
  loading,
  detail,
  onOpenChange,
}: {
  open: boolean;
  loading: boolean;
  detail: RequestLogDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const log = detail?.log;
  const body = detail?.detail;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>请求日志详情</DialogTitle>
          <DialogDescription>
            {log
              ? `${log.method} ${log.path} · ${log.request_type}`
              : "加载详细日志中..."}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> 正在加载详情...
          </div>
        ) : !log ? (
          <EmptyState
            icon={FileTextIcon}
            title="没有详情"
            description="未找到该请求日志的详情数据。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-3 rounded-lg border border-border/60 p-3 text-sm md:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">开始时间</div>
                <LocalDateTime value={log.started_at} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">完成时间</div>
                <LocalDateTime value={log.completed_at} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">状态 / 延迟</div>
                <div className="flex items-center gap-2">
                  {renderStatusCodeBadge(log.status_code)}
                  <span>{formatDuration(log.latency_ms)}</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">模型</div>
                <div>{log.model || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Token / 缓存
                </div>
                <div>
                  {formatTokenNumber(log.total_tokens)} · 缓存{" "}
                  {formatTokenNumber(log.cached_tokens)} (
                  {formatPercent(log.cache_hit_rate)})
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">密钥</div>
                <div>{log.api_key_name || "未知密钥"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">通道 / 凭据</div>
                <div>
                  {log.channel_name || "-"} · {log.credential_email || "-"}
                </div>
              </div>
            </div>

            {!body ? (
              <EmptyState
                icon={FileTextIcon}
                title="暂无详细内容"
                description="旧日志或关闭完整日志时的成功请求可能只有概要数据；报错请求会保留错误详情。"
                compact
              />
            ) : (
              <div className="grid gap-4">
                <StageTimingsBlock timings={body.stage_timings} />
                <DetailBlock
                  title="请求 Headers"
                  value={formatDetailValue(body.request_headers)}
                />
                <DetailBlock
                  title="请求 Body"
                  value={body.request_body_text}
                  truncated={body.request_body_truncated}
                  bytes={body.request_body_bytes}
                />
                <DetailBlock
                  title="转发到上游的 Body"
                  value={body.forwarded_body_text}
                  truncated={body.forwarded_body_truncated}
                  bytes={body.forwarded_body_bytes}
                />
                <DetailBlock
                  title={`上游响应${body.upstream_status_code ? ` · ${body.upstream_status_code}` : ""}`}
                  value={body.upstream_body_text}
                  truncated={body.upstream_body_truncated}
                  bytes={body.upstream_body_bytes}
                />
                <DetailBlock
                  title="上游 Headers"
                  value={formatDetailValue(body.upstream_headers)}
                />
                {(body.error_message ||
                  body.error_stack ||
                  log.error_message) && (
                  <DetailBlock
                    title={`错误详情${body.error_name ? ` · ${body.error_name}` : ""}`}
                    value={[
                      body.error_message || log.error_message || "",
                      body.error_stack || "",
                      formatDetailValue(body.error_cause),
                      formatDetailValue(body.detail),
                    ]
                      .filter(Boolean)
                      .join("\n\n")}
                  />
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageTimingsBlock({
  timings,
}: {
  timings: NonNullable<RequestLogDetail["detail"]>["stage_timings"];
}) {
  if (!timings.length) {
    return null;
  }
  const total = Math.max(
    ...timings.map((item) => item.endedAtMs),
    ...timings.map((item) => item.durationMs),
    1,
  );
  return (
    <div className="grid gap-3 rounded-lg border border-border/60 p-3">
      <div>
        <div className="font-medium">阶段耗时</div>
        <div className="text-xs text-muted-foreground">
          记录每个转发阶段的相对开始、结束和耗时；不受完整日志开关影响。
        </div>
      </div>
      <div className="grid gap-2">
        {timings.map((item, index) => (
          <div
            key={`${item.name}:${index}`}
            className="grid gap-1 rounded-md bg-muted/25 p-2 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{item.label || item.name}</span>
              <span className="font-mono text-muted-foreground">
                {formatDuration(item.durationMs)} ·{" "}
                {formatNumber(item.startedAtMs)}-{formatNumber(item.endedAtMs)}
                ms
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(2, Math.min(100, (item.durationMs / total) * 100))}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailBlock({
  title,
  value,
  truncated,
  bytes,
}: {
  title: string;
  value: string | null | undefined;
  truncated?: boolean;
  bytes?: number;
}) {
  const displayValue = value || "-";
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">
          {title}
          {truncated && (
            <Badge className="ml-2" variant="secondary">
              已截断
            </Badge>
          )}
          {bytes ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {formatNumber(bytes)} bytes
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!value}
          onClick={() => value && void copyText(value)}
        >
          <CopyIcon data-icon="inline-start" />
          复制
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
        {displayValue}
      </pre>
    </div>
  );
}

function formatDetailValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const OVERVIEW_TREND_DAYS = 7;

type DailyUsageRow = AdminOverviewStats["byDay"][number];

function buildOverviewTrendMetrics(
  rows: AdminOverviewStats["byDay"],
): TrendMetricCardProps[] {
  const days = usageDateWindow(rows, OVERVIEW_TREND_DAYS);
  const today = days[days.length - 1] ?? emptyDailyUsageRow(todayDateKey());
  const yesterday =
    days[days.length - 2] ?? emptyDailyUsageRow(addUtcDays(today.date, -1));
  const requestChange = percentChange(
    today.requestCount,
    yesterday.requestCount,
  );
  const tokenChange = percentChange(today.totalTokens, yesterday.totalTokens);
  const latencyChange = percentChange(
    today.avgFirstTokenLatencyMs,
    yesterday.avgFirstTokenLatencyMs,
  );
  const todaySuccessRate = dailySuccessRate(today);
  const yesterdaySuccessRate = dailySuccessRate(yesterday);
  const successPointChange = todaySuccessRate - yesterdaySuccessRate;
  const successDirection = directionFromDelta(successPointChange);

  return [
    {
      title: "今日请求数",
      value: formatCompactNumber(today.requestCount),
      description: `${formatNumber(today.streamCount)} 个流式 · ${formatNumber(today.errorCount)} 个错误`,
      changeLabel: formatChangePercent(requestChange.value),
      direction: requestChange.direction,
      tone: directionTone(requestChange.direction),
      data: days.map((row) => ({ date: row.date, value: row.requestCount })),
      icon: ActivityIcon,
    },
    {
      title: "今日成功率",
      value: formatPercent(todaySuccessRate),
      description: `${formatNumber(today.successCount)} 成功 / ${formatNumber(today.requestCount)} 总计`,
      changeLabel: formatPointChange(successPointChange),
      direction: successDirection,
      tone: directionTone(successDirection),
      data: days.map((row) => ({
        date: row.date,
        value: dailySuccessRate(row),
      })),
      icon: ShieldCheckIcon,
    },
    {
      title: "今日 Token",
      value: formatTokenNumber(today.totalTokens),
      description: `输入 ${formatTokenNumber(today.promptTokens)} · 输出 ${formatTokenNumber(today.completionTokens)} · 缓存 ${formatTokenNumber(today.cachedTokens)} (${formatPercent(today.cacheHitRate)})`,
      changeLabel: formatChangePercent(tokenChange.value),
      direction: tokenChange.direction,
      tone: directionTone(tokenChange.direction),
      data: days.map((row) => ({ date: row.date, value: row.totalTokens })),
      icon: DatabaseIcon,
    },
    {
      title: "今日平均首字延迟",
      value: formatDuration(today.avgFirstTokenLatencyMs),
      description: `p95 ${formatDuration(today.p95FirstTokenLatencyMs)} · ${formatTokenNumber(Math.round(today.tokensPerSecond))} token/秒`,
      changeLabel: formatChangePercent(latencyChange.value),
      direction: latencyChange.direction,
      tone: directionTone(latencyChange.direction, { lowerIsBetter: true }),
      data: days.map((row) => ({
        date: row.date,
        value: row.avgFirstTokenLatencyMs,
      })),
      icon: Clock3Icon,
    },
  ];
}

function usageDateWindow(rows: AdminOverviewStats["byDay"], days: number) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const today = todayDateKey();
  return Array.from({ length: days }, (_, index) => {
    const date = addUtcDays(today, index - days + 1);
    return byDate.get(date) ?? emptyDailyUsageRow(date);
  });
}

function emptyDailyUsageRow(date: string): DailyUsageRow {
  return {
    date,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    streamCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
    avgTokensPerRequest: 0,
    tokensPerSecond: 0,
  };
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function addUtcDays(dateKey: string, deltaDays: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function dailySuccessRate(row: DailyUsageRow) {
  return ratio(row.successCount, row.requestCount) ?? 0;
}

function percentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { value: 0, direction: "flat" as const };
  }
  if (previous === 0) {
    return {
      value: current > 0 ? 100 : 0,
      direction: current > 0 ? ("up" as const) : ("flat" as const),
    };
  }
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return { value, direction: directionFromDelta(value) };
}

function directionFromDelta(value: number): TrendDirection {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

function directionTone(
  direction: TrendDirection,
  options: { lowerIsBetter?: boolean } = {},
): TrendTone {
  if (direction === "flat") {
    return "neutral";
  }
  if (options.lowerIsBetter) {
    return direction === "down" ? "positive" : "negative";
  }
  return direction === "up" ? "positive" : "negative";
}

function formatChangePercent(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }
  return `${Math.abs(value).toFixed(1)}%`;
}

function formatPointChange(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0pct";
  }
  return `${Math.abs(value).toFixed(1)}pct`;
}

function TrendMetricCard({
  title,
  value,
  description,
  changeLabel,
  direction,
  tone,
  data,
  icon: Icon,
}: TrendMetricCardProps) {
  const directionIcon =
    direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  const toneClasses: Record<TrendTone, string> = {
    positive: "text-emerald-600 dark:text-emerald-400",
    negative: "text-destructive",
    neutral: "text-muted-foreground",
  };

  return (
    <Card className="gap-1 overflow-hidden py-3">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardDescription className="flex items-center gap-1.5 text-sm">
              <Icon className="size-3.5" />
              {title}
            </CardDescription>
            <CardTitle className="text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">
              {value}
            </CardTitle>
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          </div>
          <div
            className={`shrink-0 text-sm font-semibold tabular-nums ${toneClasses[tone]}`}
          >
            {directionIcon} {changeLabel}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`h-10 w-full min-w-0 ${toneClasses[tone]}`}>
          <LineChart
            accessibilityLayer
            width={320}
            height={40}
            data={data}
            margin={{ top: 6, right: 4, bottom: 2, left: 4 }}
            className="h-10 w-full"
          >
            <Line
              type="monotone"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2.2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </div>
      </CardContent>
    </Card>
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
            {rows.map((row, index) => (
              <UsageListRow
                key={`${row.key}:${index}`}
                maxTokens={maxTokens}
                row={row}
              />
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
          {formatTokenNumber(row.totalTokens)}
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
                      {formatTokenNumber(row.totalTokens)}
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
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        正常
      </Badge>
    );
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
      {values.slice(0, 3).map((value, index) => (
        <Badge key={`${value}:${index}`} variant="outline">
          {value}
        </Badge>
      ))}
      {values.length > 3 && (
        <Badge variant="outline">+{values.length - 3}</Badge>
      )}
    </div>
  );
}

function uniqueChannelsById(channels: ChannelRecord[]) {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    if (seen.has(channel.id)) {
      return false;
    }
    seen.add(channel.id);
    return true;
  });
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
    credentialIds: channel.credentialIds.join("\n"),
    enabled: channel.enabled,
    baseUrl: channel.baseUrl,
    priority: channel.priority.toString(),
    weight: channel.weight.toString(),
    modelAllowlist: channel.modelAllowlist.join("\n"),
  };
}

function channelFormToPayload(form: ChannelFormState): ChannelPayload {
  const credentialIds = parseList(form.credentialIds);
  return {
    name: form.name.trim(),
    credentialId: credentialIds[0],
    credentialIds,
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    priority: integerValue(form.priority, 100),
    weight: Math.max(1, integerValue(form.weight, 1)),
    modelAllowlist: parseList(form.modelAllowlist),
  };
}

function globalSettingsProxyForm(
  settings: GlobalSettingsRecord,
): CredentialProxyFormState {
  const proxy = settings.proxy;
  return {
    enabled: proxy?.enabled ?? true,
    type: proxy?.type ?? "socks5h",
    host: proxy?.host ?? "",
    port: proxy?.port ? String(proxy.port) : "1080",
    username: proxy?.username ?? "",
    password: "",
  };
}

function globalProxyText(settings: GlobalSettingsRecord) {
  const proxy = settings.proxy;
  if (!proxy) {
    return "未配置";
  }
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function globalProxySourceLabel(source: GlobalSettingsRecord["proxySource"]) {
  const labels: Record<GlobalSettingsRecord["proxySource"], string> = {
    database: "数据库",
    environment: "环境变量",
    none: "未配置",
  };
  return labels[source] || source;
}

function userAgentSourceLabel(source: GlobalSettingsRecord["userAgentSource"]) {
  const labels: Record<GlobalSettingsRecord["userAgentSource"], string> = {
    database: "数据库",
    environment: "环境变量",
    default: "默认值",
  };
  return labels[source] || source;
}

function emptyProxyPoolForm(): ProxyPoolFormState {
  return {
    name: "",
    enabled: true,
    type: "socks5h",
    host: "",
    port: "1080",
    username: "",
    password: "",
    notes: "",
  };
}

function proxyPoolForm(proxy: ProxyPoolRecord): ProxyPoolFormState {
  return {
    name: proxy.name,
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: String(proxy.port),
    username: proxy.username,
    password: "",
    notes: proxy.notes,
  };
}

function proxyPoolPayload(
  form: ProxyPoolFormState,
  existing: ProxyPoolRecord | null,
): ProxyPoolPayload | null {
  const name = form.name.trim();
  const host = form.host.trim();
  const port = integerValue(form.port, 0);
  if (!name) {
    toast.error("请输入代理名称");
    return null;
  }
  if (!host) {
    toast.error("请输入 SOCKS5 代理主机");
    return null;
  }
  if (port < 1 || port > 65535) {
    toast.error("代理端口必须在 1 到 65535 之间");
    return null;
  }
  return {
    name,
    enabled: form.enabled,
    type: form.type,
    host,
    port,
    username: form.username.trim(),
    ...(form.password.trim() || !existing ? { password: form.password } : {}),
    notes: form.notes.trim(),
  };
}

function proxyPoolRecordText(proxy: ProxyPoolRecord) {
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function proxyPoolSelectionText(
  credential: CodexCredentialRecord,
  proxyPool: ProxyPoolRecord[],
) {
  if (!credential.proxyPoolId) {
    return "未选择";
  }
  const proxy = proxyPool.find((item) => item.id === credential.proxyPoolId);
  return proxy ? proxyPoolRecordText(proxy) : "代理不存在";
}

function credentialProxyForm(
  credential: CodexCredentialRecord,
): CredentialProxyFormState {
  const proxy = credential.proxy;
  return {
    enabled: proxy?.enabled ?? true,
    type: proxy?.type ?? "socks5h",
    host: proxy?.host ?? "",
    port: proxy?.port ? String(proxy.port) : "1080",
    username: proxy?.username ?? "",
    password: "",
  };
}

function credentialProxyText(credential: CodexCredentialRecord) {
  const proxy = credential.proxy;
  if (!proxy) {
    return "未配置";
  }
  const auth = proxy.username
    ? `${proxy.username}${proxy.passwordSet ? ":******" : ""}@`
    : "";
  return `${proxy.enabled ? "已启用" : "已停用"} · ${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function credentialUpstreamTransportText(transport: CodexUpstreamTransport) {
  return transport === "websocket" ? "WebSocket" : "HTTP";
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

function isValidRetentionDays(value: number) {
  return Number.isFinite(value) && value >= 1 && value <= 3650;
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

function metadataString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function metadataInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
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

function credentialUploadPayloads(parsed: unknown) {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) {
    return [];
  }
  if (Array.isArray(parsed.credentials)) {
    return parsed.credentials.filter(isRecord);
  }
  if (Array.isArray(parsed.accounts)) {
    return parsed.accounts.filter(isRecord);
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data.filter(isRecord);
  }
  return [parsed];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function usageHealthScore(health: CodexCredentialRecord["usageHealth"]) {
  return clamp(health?.score ?? 100, 0, 100);
}

function isFastCredentialPlan(planType: string) {
  const normalized = planType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return (
    normalized === "pro" || normalized === "pro20" || normalized === "pro20x"
  );
}

function codexPlanRank(planType: string) {
  const normalized = codexPlanKey(planType);
  if (normalized === "pro") {
    return 50;
  }
  if (
    normalized === "prolite" ||
    normalized === "pro-lite" ||
    normalized === "pro_lite"
  ) {
    return 40;
  }
  if (normalized === "team") {
    return 30;
  }
  if (normalized === "plus") {
    return 20;
  }
  if (normalized === "free") {
    return 10;
  }
  return 0;
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

function formatNullableDuration(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatDuration(value)
    : "-";
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(value);
}

function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatScaledNumber(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatScaledNumber(value / 1_000_000)}M`;
  }
  if (absValue >= 1_000) {
    return `${formatScaledNumber(value / 1_000)}K`;
  }
  return formatNumber(value);
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
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
