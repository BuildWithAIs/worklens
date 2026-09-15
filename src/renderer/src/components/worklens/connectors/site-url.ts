// Complete only plausible bare site addresses. This does not verify reachability.
export function completeSiteUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate || /[\s\\?#@%]/u.test(candidate) || candidate.includes("://"))
    return value;
  const authority = candidate.split("/")[0];
  // Require a dotted hostname (or IPv4), optionally followed by a numeric port.
  // Single-label intranet hosts must include an explicit protocol.
  if (!/^[^:]+(?::[0-9]+)?$/u.test(authority)) return value;
  try {
    const url = new URL(`https://${candidate}`);
    const labels = url.hostname.split(".");
    if (
      labels.length < 2 ||
      url.hostname.length > 253 ||
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
      )
    )
      return value;
    if (/^[0-9.]+$/.test(url.hostname)) {
      // Reject shorthand numeric hosts normalized by URL (e.g. 127.1).
      if (authority.split(":")[0] !== url.hostname) return value;
    } else if (!/[a-z]/i.test(labels[labels.length - 1])) return value;
    return `https://${candidate}`;
  } catch {
    return value;
  }
}
