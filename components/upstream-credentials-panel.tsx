"use client";

import * as React from "react";
import { AlertTriangleIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { adminErrorMessage, createUpstreamCredential, deleteUpstreamCredential, updateUpstreamCredential, type UpstreamCredentialPayload } from "@/lib/admin-api";
import type { ApiUpstreamProvider, GlobalSettingsRecord, ProxyPoolRecord, UpstreamCredentialRecord } from "@/src/shared/types/entities";

type ProxyMode = "global" | "pool" | "direct" | "keep";
type CredentialForm = {
  provider: ApiUpstreamProvider;
  name: string;
  apiKey: string;
  enabled: boolean;
  priority: string;
  weight: string;
  proxyMode: ProxyMode;
  proxyPoolId: string;
};

const PROVIDER_LABELS: Record<ApiUpstreamProvider, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
};

export function UpstreamCredentialsPanel({
  credentials,
  globalSettings,
  proxyPool,
  onSaved,
  onDeleted,
}: {
  credentials: UpstreamCredentialRecord[];
  globalSettings: GlobalSettingsRecord;
  proxyPool: ProxyPoolRecord[];
  onSaved: (credential: UpstreamCredentialRecord) => void;
  onDeleted: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UpstreamCredentialRecord | null>(null);
  const [deleting, setDeleting] = React.useState<UpstreamCredentialRecord | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function toggleEnabled(credential: UpstreamCredentialRecord, enabled: boolean) {
    setPendingId(credential.id);
    try {
      onSaved(await updateUpstreamCredential(credential.id, { enabled }));
      toast.success(enabled ? "上游 API 凭据已启用" : "上游 API 凭据已停用");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setPendingId(deleting.id);
    try {
      await deleteUpstreamCredential(deleting.id);
      try {
        await onDeleted(deleting.id);
        toast.success("上游 API 凭据已删除，通道绑定已刷新");
      } catch (error) {
        toast.error(`凭据已删除，但通道刷新失败，请刷新管理数据：${adminErrorMessage(error)}`);
      }
      setDeleting(null);
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
          <CardTitle>上游 API Key 凭据</CardTitle>
          <CardDescription>
            OpenAI-compatible / Anthropic 供应商密钥，不是下游 relay_sk 密钥，也不是 OAuth 账号。仅展示名称和掩码，不返回或导出 Key 明文。
          </CardDescription>
          <CardAction>
            <Button type="button" onClick={() => { setEditing(null); setOpen(true); }}>
              <PlusIcon data-icon="inline-start" />
              新建上游凭据
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>上游 API 调用可能按量计费</AlertTitle>
            <AlertDescription>
              添加凭据后，在通道页创建对应 API 通道并手工填写已授权模型。新 API 通道默认关闭，必须在下游 Relay Key 的通道白名单中显式绑定才可使用；空白名单仅允许 OAuth 通道。模型和图像能力以供应商及该 Key 的实际权限为准。
            </AlertDescription>
          </Alert>
          {credentials.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
                <EmptyTitle>暂无上游 API Key</EmptyTitle>
                <EmptyDescription>添加供应商 Key 后，可在同 provider 的通道内绑定一个或多个凭据。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称 / Key 掩码</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>优先级 / 权重</TableHead>
                  <TableHead>代理</TableHead>
                  <TableHead>使用状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell>
                      <div className="font-medium">{credential.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {credential.keySet ? `${credential.keyPrefix}…` : "未设置 Key"}
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{PROVIDER_LABELS[credential.provider]}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label={`启用 ${credential.name}`}
                          checked={credential.enabled}
                          disabled={pendingId !== null}
                          onCheckedChange={(checked) => toggleEnabled(credential, Boolean(checked))}
                        />
                        {pendingId === credential.id && <Spinner />}
                      </div>
                    </TableCell>
                    <TableCell>{credential.priority} / {credential.weight}</TableCell>
                    <TableCell>{proxyLabel(credential, proxyPool, globalSettings)}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                        <span>最近使用：{dateLabel(credential.lastUsedAt)}</span>
                        {credential.usageHealth && <span>健康度 {credential.usageHealth.score}%</span>}
                        {credential.cooldownUntil && <span>冷却至：{dateLabel(credential.cooldownUntil)}</span>}
                        {credential.lastError && <span className="max-w-64 truncate" title={credential.lastError}>{credential.lastError}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" disabled={pendingId !== null} onClick={() => { setEditing(credential); setOpen(true); }}>
                          <PencilIcon data-icon="inline-start" />编辑
                        </Button>
                        <Button type="button" variant="outline" size="sm" disabled={pendingId !== null} onClick={() => setDeleting(credential)}>
                          <Trash2Icon data-icon="inline-start" />删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!saving}>
          {open && (
            <UpstreamCredentialForm
              key={editing?.id || "new"}
              credential={editing}
              proxyPool={proxyPool}
              globalSettings={globalSettings}
              pending={saving}
              onPendingChange={setSaving}
              onCancel={() => setOpen(false)}
              onSaved={(saved) => { onSaved(saved); setOpen(false); }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(next) => { if (!next && !pendingId) setDeleting(null); }}>
        <DialogContent showCloseButton={!pendingId}>
          <DialogHeader>
            <DialogTitle>删除上游 API 凭据？</DialogTitle>
            <DialogDescription>
              将删除 {deleting?.name}（{deleting?.keyPrefix}…）并移除对应通道的凭据绑定。此操作不可撤销；不会删除下游 Relay Key，也不会撤销供应商端的 Key。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={Boolean(pendingId)} onClick={() => setDeleting(null)}>取消</Button>
            <Button type="button" variant="destructive" disabled={Boolean(pendingId)} onClick={remove}>
              {pendingId && <Spinner data-icon="inline-start" />}删除凭据
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UpstreamCredentialForm({
  credential,
  proxyPool,
  globalSettings,
  pending,
  onPendingChange,
  onCancel,
  onSaved,
}: {
  credential: UpstreamCredentialRecord | null;
  proxyPool: ProxyPoolRecord[];
  globalSettings: GlobalSettingsRecord;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onCancel: () => void;
  onSaved: (credential: UpstreamCredentialRecord) => void;
}) {
  const initialProxyMode: ProxyMode = credential?.proxy?.enabled
    ? "keep"
    : credential?.proxyPoolId
      ? "pool"
      : (credential?.useGlobalProxy ?? true)
        ? "global"
        : "direct";
  const [form, setForm] = React.useState<CredentialForm>(() => ({
    provider: credential?.provider ?? "openai",
    name: credential?.name ?? "",
    apiKey: "",
    enabled: credential?.enabled ?? true,
    priority: String(credential?.priority ?? 100),
    weight: String(credential?.weight ?? 1),
    proxyMode: initialProxyMode,
    proxyPoolId: credential?.proxyPoolId ?? "",
  }));
  const [error, setError] = React.useState<string | null>(null);
  const update = <K extends keyof CredentialForm>(key: K, value: CredentialForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const proxyModes: { value: ProxyMode; label: string }[] = [
    { value: "global", label: "全局代理" },
    { value: "pool", label: "代理池" },
    { value: "direct", label: "直连" },
    ...(credential?.proxy?.enabled ? [{ value: "keep" as const, label: "保留独立代理" }] : []),
  ];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const apiKey = form.apiKey.trim();
    const priority = Number(form.priority);
    const weight = Number(form.weight);
    if (!credential && !apiKey) { setError("创建凭据必须填写 API Key"); return; }
    if (!form.name.trim()) { setError("请填写凭据名称"); return; }
    if (!form.priority.trim() || !Number.isSafeInteger(priority) || !form.weight.trim() || !Number.isSafeInteger(weight) || weight < 1) {
      setError("优先级必须为整数，权重必须为正整数"); return;
    }
    const proxyChanged = !credential || form.proxyMode !== initialProxyMode ||
      (form.proxyMode === "pool" && form.proxyPoolId !== credential.proxyPoolId);
    if (proxyChanged && form.proxyMode === "pool" && !proxyPool.some((proxy) => proxy.id === form.proxyPoolId && proxy.enabled)) {
      setError("请选择一个已启用的代理池项目"); return;
    }
    setError(null);
    onPendingChange(true);
    try {
      const payload: UpstreamCredentialPayload = {
        provider: form.provider,
        name: form.name.trim(),
        ...(apiKey ? { apiKey } : {}),
        enabled: form.enabled,
        priority,
        weight,
        ...(!proxyChanged || form.proxyMode === "keep" ? {} : {
          proxy: null,
          useGlobalProxy: form.proxyMode === "global",
          proxyPoolId: form.proxyMode === "pool" ? form.proxyPoolId : null,
        }),
      };
      const saved = credential
        ? await updateUpstreamCredential(credential.id, payload)
        : await createUpstreamCredential({ ...payload, provider: form.provider, apiKey });
      update("apiKey", "");
      onSaved(saved);
      toast.success(credential ? "上游 API 凭据已保存" : "上游 API 凭据已创建");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      onPendingChange(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{credential ? "编辑上游 API 凭据" : "新建上游 API 凭据"}</DialogTitle>
        <DialogDescription>
          {credential ? `当前 Key：${credential.keyPrefix}…。不会回填明文，Key 留空保持原值。` : "填写供应商提供的 API Key，仅用于上游 API 调用，不使用 OAuth 导入或刷新流程。"}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-disabled={Boolean(credential) || pending}>
          <FieldLabel id="upstream-provider-label">Provider</FieldLabel>
          <ToggleGroup
            aria-labelledby="upstream-provider-label"
            variant="outline"
            spacing={2}
            value={[form.provider]}
            disabled={Boolean(credential) || pending}
            onValueChange={(values) => { if (values[0] === "openai" || values[0] === "anthropic") update("provider", values[0]); }}
          >
            <ToggleGroupItem value="openai">OpenAI-compatible</ToggleGroupItem>
            <ToggleGroupItem value="anthropic">Anthropic</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>Provider 创建后不可修改，渠道仅可绑定相同 provider 的凭据。</FieldDescription>
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor="upstream-name">名称</FieldLabel>
          <Input id="upstream-name" required disabled={pending} value={form.name} placeholder="生产 API Key" onChange={(event) => update("name", event.target.value)} />
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor="upstream-api-key">{credential ? "替换 API Key（可选）" : "API Key（必填）"}</FieldLabel>
          <Input id="upstream-api-key" type="password" autoComplete="new-password" spellCheck={false} required={!credential} disabled={pending} value={form.apiKey} placeholder={credential ? "留空保持原 Key" : "供应商 API Key"} onChange={(event) => update("apiKey", event.target.value)} />
          <FieldDescription>保存后仅返回掩码。编辑时输入新 Key 将替换原值，留空不改变。</FieldDescription>
        </Field>
        <Field orientation="horizontal" data-disabled={pending}>
          <FieldContent>
            <FieldLabel htmlFor="upstream-enabled">启用凭据</FieldLabel>
            <FieldDescription>停用后不再用于新的上游请求，通道启用和下游白名单仍单独生效。</FieldDescription>
          </FieldContent>
          <Switch id="upstream-enabled" disabled={pending} checked={form.enabled} onCheckedChange={(checked) => update("enabled", Boolean(checked))} />
        </Field>
        <FieldGroup className="sm:grid sm:grid-cols-2">
          <Field data-disabled={pending}>
            <FieldLabel htmlFor="upstream-priority">优先级</FieldLabel>
            <Input id="upstream-priority" type="number" step={1} required disabled={pending} value={form.priority} onChange={(event) => update("priority", event.target.value)} />
            <FieldDescription>数值越高越优先。</FieldDescription>
          </Field>
          <Field data-disabled={pending}>
            <FieldLabel htmlFor="upstream-weight">权重</FieldLabel>
            <Input id="upstream-weight" type="number" min={1} step={1} required disabled={pending} value={form.weight} onChange={(event) => update("weight", event.target.value)} />
            <FieldDescription>同优先级下按权重选择。</FieldDescription>
          </Field>
        </FieldGroup>
        <Field data-disabled={pending}>
          <FieldLabel id="upstream-proxy-label">代理来源</FieldLabel>
          <ToggleGroup aria-labelledby="upstream-proxy-label" variant="outline" spacing={2} className="flex-wrap" value={[form.proxyMode]} disabled={pending} onValueChange={(values) => { const mode = proxyModes.find((item) => item.value === values[0]); if (mode) update("proxyMode", mode.value); }}>
            {proxyModes.map((mode) => <ToggleGroupItem key={mode.value} value={mode.value}>{mode.label}</ToggleGroupItem>)}
          </ToggleGroup>
          <FieldDescription>
            {form.proxyMode === "global" ? `跟随全局设置（当前${globalSettings.proxy?.enabled ? "已启用" : "未启用，将直连"}）。` : form.proxyMode === "pool" ? "使用选定的代理池项目，不回退全局代理。" : form.proxyMode === "keep" ? "保留当前凭据独立代理配置，不读取或回填代理密码。" : "不使用全局、代理池或独立代理。"}
            选择其他来源并保存时，将清除独立代理配置。
          </FieldDescription>
        </Field>
        {form.proxyMode === "pool" && (
          <Field data-disabled={pending}>
            <FieldLabel htmlFor="upstream-proxy-pool">代理池项目</FieldLabel>
            <FieldDescription>保持原选择不会改写代理设置；更换时只能选择已启用的代理池项目。</FieldDescription>
            <Select value={form.proxyPoolId || null} disabled={pending} items={proxyPool.map((proxy) => ({ value: proxy.id, label: `${proxy.name} · ${proxy.type}${proxy.enabled ? "" : "（已停用）"}` }))} onValueChange={(value) => update("proxyPoolId", value ?? "")}>
              <SelectTrigger id="upstream-proxy-pool" className="w-full"><SelectValue placeholder="选择已启用的代理池项目" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {proxyPool.map((proxy) => <SelectItem key={proxy.id} value={proxy.id} disabled={!proxy.enabled}>{proxy.name} · {proxy.type}{!proxy.enabled && "（已停用）"}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            {proxyPool.every((proxy) => !proxy.enabled) && <FieldDescription>暂无已启用项目，请先在代理池页面添加或启用。</FieldDescription>}
          </Field>
        )}
      </FieldGroup>
      {error && <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>请检查表单</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={pending}>{pending && <Spinner data-icon="inline-start" />}{credential ? "保存凭据" : "创建凭据"}</Button>
      </DialogFooter>
    </form>
  );
}

function proxyLabel(credential: UpstreamCredentialRecord, proxyPool: ProxyPoolRecord[], globalSettings: GlobalSettingsRecord) {
  if (credential.proxy?.enabled) return `独立代理 · ${credential.proxy.type}`;
  if (credential.proxyPoolId) {
    const proxy = proxyPool.find((item) => item.id === credential.proxyPoolId);
    return proxy ? `代理池 · ${proxy.name}${proxy.enabled ? "" : "（已停用）"}` : "代理池 · 已缺失";
  }
  if (credential.useGlobalProxy) return `全局代理 · ${globalSettings.proxy?.enabled ? "已启用" : "未启用"}`;
  return "直连";
}

function dateLabel(value: string | null) {
  return value ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC") : "—";
}
