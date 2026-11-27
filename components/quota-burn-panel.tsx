"use client";

import * as React from "react";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { adminErrorMessage, getQuotaBurn, type QuotaBurnReport } from "@/lib/admin-api";
import type { QuotaBurnEstimate, QuotaBurnTokens, QuotaBurnWindow } from "@/src/shared/types/entities";

type TokenKind = "input" | "cacheRead" | "cacheWrite" | "inputUnsplit" | "output";

const KIND_LABELS: Record<TokenKind, string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  inputUnsplit: "Input+写缓存(旧日志)",
  output: "Output",
};
const KIND_COLORS: Record<TokenKind, string> = {
  input: "bg-sky-500",
  cacheRead: "bg-emerald-500",
  cacheWrite: "bg-amber-500",
  inputUnsplit: "bg-slate-400",
  output: "bg-violet-500",
};

// Loads only when opened, so the credential list stays as fast as before.
export function QuotaBurnPanel({
  provider, credentialId, defaultOpen = false,
}: { provider: "claude" | "codex"; credentialId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [report, setReport] = React.useState<QuotaBurnReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getQuotaBurn(provider, credentialId));
    } catch (failure) {
      setError(adminErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [provider, credentialId]);

  const toggle = () => {
    if (!open && !report && !loading) void load();
    setOpen(!open);
  };

  return (
    <div className="grid gap-2 text-sm">
      <button
        type="button"
        className="flex items-center justify-between gap-2 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>Token / 额度消耗：</span>
        <ChevronDownIcon className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/35 p-3">
          {!report && loading && (
            <div className="flex items-center gap-2 text-muted-foreground"><Spinner data-icon="inline-start" />计算中</div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
          {report && (
            <>
              {report.windows.map((window) => (
                <BurnWindow key={window.id} report={report} window={window} />
              ))}
              <div className="flex items-start justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  额度只有约 {formatPoints(report.windows.find((w) => w.resolution)?.resolution ?? 1)} 精度，±
                  为取整误差。{report.shared_credentials > 1 && `同一订阅的 ${report.shared_credentials} 个凭据合并计算。`}
                  只统计经过 Relay 的 token。
                </span>
                <Button size="icon-xs" variant="ghost" aria-label="重新计算" disabled={loading} onClick={() => void load()}>
                  {loading ? <Spinner /> : <RefreshCwIcon />}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BurnWindow({ report, window }: { report: QuotaBurnReport; window: QuotaBurnWindow }) {
  return (
    <div className="grid gap-2 rounded-md border border-border/50 bg-background/55 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{window.id} 窗口</span>
        <span className="text-[11px] text-muted-foreground">
          {window.resetAt ? `本周期 ${formatTime(window.resetAt)} 重置` : "无进行中的周期"}
        </span>
      </div>
      <EstimateLine label="本周期" estimate={window.current} />
      {/* With one cycle in range, the recent line repeats the current one. */}
      {(!window.resetAt || window.recent.cycles !== window.current.cycles) && (
        <EstimateLine label={window.id === "5h" ? "近 7 天" : "近 14 天"} estimate={window.recent} />
      )}
      <TokenBreakdown tokens={window.current.cycles ? window.current.tokens : window.recent.tokens}
        weights={report.price_weights} />
    </div>
  );
}

function EstimateLine({ label, estimate }: { label: string; estimate: QuotaBurnEstimate }) {
  const ratio = estimate.tokensPerPercent !== null;
  return (
    <div className="grid gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
        <span className="text-muted-foreground">{label}</span>
        {estimate.delta !== null && estimate.tokens.total > 0 && (
          <span>
            用了 <b className="tabular-nums">{formatTokens(estimate.tokens.total)}</b> token，额度掉{" "}
            <b className="tabular-nums">{formatPoints(estimate.delta)}</b>
            <span className="text-muted-foreground"> ±{formatPoints(estimate.deltaError ?? 0)}</span>
          </span>
        )}
        {estimate.status === "insufficient" && <Badge variant="outline" className="h-5 px-1.5 text-[11px]">数据不足</Badge>}
        {estimate.status === "rough" && <Badge variant="outline" className="h-5 px-1.5 text-[11px] text-amber-600 dark:text-amber-300">误差较大</Badge>}
      </div>
      {ratio ? (
        <div className="text-xs">
          每 1% ≈ <b className="tabular-nums">{formatTokens(estimate.tokensPerPercent!)}</b> token
          <span className="text-muted-foreground tabular-nums">
            {" "}（{formatTokens(estimate.tokensPerPercentLow!)}–{formatTokens(estimate.tokensPerPercentHigh!)}）
            {estimate.cycles > 1 && ` · ${estimate.cycles} 个周期`}
          </span>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">{estimate.reason}</div>
      )}
    </div>
  );
}

function TokenBreakdown({ tokens, weights }: { tokens: QuotaBurnTokens; weights: QuotaBurnReport["price_weights"] }) {
  if (!tokens.total) return null;
  const kinds: Array<{ kind: TokenKind; value: number; weight: number | null }> = [
    { kind: "input" as const, value: tokens.input, weight: weights.input },
    { kind: "cacheRead" as const, value: tokens.cacheRead, weight: weights.cacheRead },
    { kind: "cacheWrite" as const, value: tokens.cacheWrite ?? 0, weight: weights.cacheWrite },
    { kind: "inputUnsplit" as const, value: tokens.inputUnsplit, weight: null },
    { kind: "output" as const, value: tokens.output, weight: weights.output },
  ].filter((item) => item.value > 0 || (item.kind === "cacheWrite" && tokens.cacheWrite !== null));
  // Old Claude rows cannot split input from cache writes; price them as input.
  const cost = (item: (typeof kinds)[number]) => item.value * (item.weight ?? weights.input);
  const totalCost = kinds.reduce((sum, item) => sum + cost(item), 0);
  const top = kinds.reduce((best, item) => (cost(item) > cost(best) ? item : best), kinds[0]);
  return (
    <div className="grid gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {kinds.map((item) => (
          <div key={item.kind} className={KIND_COLORS[item.kind]} style={{ width: `${(cost(item) / totalCost) * 100}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        <span />
        <span className="text-muted-foreground">类型</span>
        <span className="text-right text-muted-foreground">token</span>
        <span className="text-right text-muted-foreground">估算占比</span>
        {kinds.map((item) => (
          <React.Fragment key={item.kind}>
            <span className={`size-2 rounded-full ${KIND_COLORS[item.kind]}`} />
            <span className={item === top ? "font-medium" : ""}>{KIND_LABELS[item.kind]}</span>
            <span className="text-right">{formatTokens(item.value)}</span>
            <span className="text-right">{totalCost ? `${Math.round((cost(item) / totalCost) * 100)}%` : "-"}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">
        估算占比按 API 价格比例（input 1 : cache read {weights.cacheRead}
        {weights.cacheWrite !== null && ` : cache write ${weights.cacheWrite}`} : output {weights.output}）折算，
        订阅额度的真实权重未公开。
      </div>
    </div>
  );
}

function formatTokens(value: number) {
  const abs = Math.abs(value);
  const [scale, suffix] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const scaled = value / scale;
  return `${Number(scaled.toFixed(Math.abs(scaled) >= 100 || !suffix ? 0 : Math.abs(scaled) >= 10 ? 1 : 2))}${suffix}`;
}

function formatPoints(value: number) {
  return `${Number(value.toFixed(2))}%`;
}

function formatTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
