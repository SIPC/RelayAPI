"use client";

import * as React from "react";
import { KeyRoundIcon, ShieldAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

export function WebAccessLogin() {
  const [accessKey, setAccessKey] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = accessKey.trim();
    if (!trimmed) {
      setError("请输入管理台访问密钥");
      return;
    }

    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/web-login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessKey: trimmed }),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(
          parsed?.error?.message || parsed?.message || "管理台访问密钥验证失败",
        );
      }
      window.location.reload();
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : String(loginError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRoundIcon className="size-6" />
          </div>
          <CardTitle className="text-xl">RelayAPI 管理台访问验证</CardTitle>
          <CardDescription>
            请输入服务首次启动时输出在控制台中的管理台访问密钥。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {error && (
              <Alert variant="destructive">
                <ShieldAlertIcon />
                <AlertTitle>验证失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label htmlFor="web-access-key">管理台访问密钥</Label>
              <Input
                id="web-access-key"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={accessKey}
                onChange={(event) => setAccessKey(event.target.value)}
                placeholder="relay_web_..."
              />
            </div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              进入管理台
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
