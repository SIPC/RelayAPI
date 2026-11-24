export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeWebAccessKey } =
      await import("./src/server/services/webAccess");
    const { startCodexCredentialRefreshScheduler } =
      await import("./src/server/services/codexCredentialRefreshScheduler");
    const { startClaudeCredentialRefreshScheduler } =
      await import("./src/server/services/claudeCredentialRefreshScheduler");
    const { startClaudeQuotaScheduler } = await import("./src/server/services/claudeQuota");
    initializeWebAccessKey();
    startCodexCredentialRefreshScheduler();
    startClaudeCredentialRefreshScheduler();
    startClaudeQuotaScheduler();
  }
}
