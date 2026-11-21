// CC Switch evaluates this object expression directly, not as a module.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
({
  request: {
    url: "{{baseUrl}}".replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/usage",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    if (!response || response.schema !== "relay.codex-quota.v1") {
      throw new Error("不是 RelayAPI Codex 额度响应，请检查 Base URL");
    }
    var rows = [];
    var unknown = 0;
    (response.credentials || []).forEach(function(c) {
      var cache = c.cache || {};
      (c.windows || []).forEach(function(w) {
        if (typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) {
          unknown++;
          return;
        }
        var used = Math.max(0, Math.min(100, w.usedPercent));
        rows.push({
          planName: (c.label || c.ref) + " · " + (w.label || w.id),
          total: 100,
          used: used,
          remaining: 100 - used,
          unit: "%",
          extra: "重置 " + (w.resetAt || "未知")
            + "；快照 " + (cache.retrievedAt || "未知")
            + "；" + (w.state || cache.state || "unknown")
            + "；路由 " + (c.routingState || "unknown")
        });
      });
    });
    if (!rows.length) throw new Error("额度暂无可用快照或未绑定 Codex 通道，请稍后重试或检查 Key 绑定");
    if (unknown) rows[0].extra += "；另有 " + unknown + " 项额度未知";
    return rows;
  }
})
