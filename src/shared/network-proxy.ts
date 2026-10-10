// Proxy parsing shared by the main process and the settings UI.

/** Public HTTPS address used to detect and test the effective proxy. */
export const PROXY_PROBE_URL = "https://www.gstatic.com/generate_204";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Normalizes "127.0.0.1:7890" or "http://host:port/" to an origin such as
 * "http://127.0.0.1:7890". Credentials, paths and other schemes are rejected.
 */
export function normalizeProxyUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" || !url.hostname) return undefined;
  return url.origin;
}

/** Reads a PAC-style result from Chromium, e.g. "PROXY 127.0.0.1:7890; DIRECT". */
export function parseProxyRule(rule: string): {
  proxy?: string;
  unsupported?: string;
} {
  let unsupported: string | undefined;
  for (const entry of rule.split(";")) {
    const [type = "", host = ""] = entry.trim().split(/\s+/);
    const kind = type.toUpperCase();
    if (kind === "DIRECT") break;
    const proxy =
      kind === "PROXY" || kind === "HTTP"
        ? normalizeProxyUrl(`http://${host}`)
        : kind === "HTTPS"
          ? normalizeProxyUrl(`https://${host}`)
          : undefined;
    if (proxy) return { proxy };
    if (host) unsupported ??= entry.trim();
  }
  return unsupported ? { unsupported } : {};
}

export function proxyBypassList(bypass = "") {
  return [
    ...LOOPBACK_HOSTS,
    ...bypass
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ];
}

/** Matches NO_PROXY-style entries: "example.com" also covers its subdomains. */
export function bypassesProxy(hostname: string, list: string[]) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^127\./.test(host)) return true;
  return list.some((entry) => {
    if (entry === "*") return true;
    const domain = entry.replace(/^\*?\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}
