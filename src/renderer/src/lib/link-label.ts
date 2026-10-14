function middle(value: string, limit: number) {
  if (value.length <= limit) return value;
  const end = Math.max(12, Math.floor(limit / 2));
  return value.slice(0, limit - end - 1) + "…" + value.slice(-end);
}

// Keep the start and the extension of a long file name. The limit is in
// display columns: CJK characters and emoji count as two, and characters are
// never split.
export function shortFileName(name: string, limit = 40) {
  const chars = Array.from(name);
  const width = (char: string) => (char.codePointAt(0)! >= 0x2e80 ? 2 : 1);
  const take = (list: string[], columns: number) => {
    const kept: string[] = [];
    for (const char of list) {
      columns -= width(char);
      if (columns < 0) break;
      kept.push(char);
    }
    return kept;
  };
  if (chars.reduce((total, char) => total + width(char), 0) <= limit)
    return name;
  const endColumns = Math.max(12, Math.floor(limit / 2));
  const end = take([...chars].reverse(), endColumns).reverse();
  const start = take(chars, limit - endColumns - 1);
  return start.join("") + "…" + end.join("");
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
