import type { ConnectionSnapshot } from "./connection";
import { ConfluenceHttp, ServiceError } from "./http";

export async function testConnection(
  snapshot: ConnectionSnapshot,
  fetcher: typeof fetch = fetch,
) {
  const signal = AbortSignal.any([
    snapshot.signal,
    AbortSignal.timeout(15_000),
  ]);
  const http = new ConfluenceHttp(snapshot, signal, fetcher);
  if (
    snapshot.settings.deployment === "cloud" &&
    snapshot.settings.tokenType === "scoped"
  ) {
    // The gateway authenticates against cloudId, so also bind it to the UI's URL.
    // This public site lookup receives no credential and follows no redirects.
    const response = await fetcher(
      new URL("/_edge/tenant_info", snapshot.settings.url),
      {
        signal,
        redirect: "manual",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(
        "invalid_site",
        "无法验证站点 URL 对应的 Cloud ID",
      );
    }
    const tenant = await http.decode(response);
    if (tenant.cloudId !== snapshot.settings.cloudId)
      throw new ServiceError("invalid_site", "Cloud ID 与站点 URL 不匹配");
  }
  const user = await http.json("/rest/api/user/current");
  if (
    user.type === "anonymous" ||
    ![user.accountId, user.username, user.userKey].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  )
    throw new ServiceError(
      "authentication",
      "服务未返回已登录用户，请检查 token 和认证方式",
    );
  return `已连接：${user.displayName ?? user.username ?? user.accountId} · ${snapshot.settings.url}`;
}
