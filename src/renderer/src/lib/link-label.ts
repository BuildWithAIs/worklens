function middle(value: string, limit: number) {
  if (value.length <= limit) return value;
  const end = Math.max(12, Math.floor(limit / 2));
  return value.slice(0, limit - end - 1) + "…" + value.slice(-end);
}

export function fileName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

export function shortUrl(value: string, limit = 72) {
  if (value.length <= limit) return value;
  try {
    const url = new URL(value);
    const host = url.host;
    const tail = url.pathname.split("/").filter(Boolean).at(-1);
    const suffix = tail ? "/…/" + tail : "/";
    const query = url.search ? "?…" : url.hash ? "#…" : "";
    return host + middle(suffix + query, Math.max(18, limit - host.length));
  } catch {
    return middle(value, limit);
  }
}
