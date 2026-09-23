/** Recognize explicit local paths, never web URLs or arbitrary prose. */
export function isLocalReference(value: string) {
  return (
    value.length <= 4096 &&
    !/[\0\r\n]/.test(value) &&
    !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(
      value.replace(/^[A-Za-z]:[\\/]/, "/"),
    ) &&
    (/^(?:\/|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|workspace\/|artifacts\/)/.test(
      value,
    ) ||
      /^(?:[^\s<>:"|?*]+[\\/])[^\s<>:"|?*]+\.[a-z\d]{1,12}$/i.test(value) ||
      /^[^\s<>:"|?*\\/]+\.(?:html?|png|jpe?g|gif|webp|avif|svg|bmp|ico|pdf|docx?|xlsx?|pptx?|txt|md|markdown|csv|tsv|json|ya?ml|xml|zip|tar|gz|7z|rar|mp3|m4a|wav|mp4|mov|py|[cm]?js|ts|tsx|jsx|css|scss|sql|sh|ps1|ipynb|log|rtf|odt|epub|srt|vtt|ass|ssa)$/i.test(
        value,
      ))
  );
}

/** Conservative plain-text detection. Paths with spaces should be quoted or linked. */
export function localPathSpans(text: string) {
  const pattern =
    /(?:^|[\s（(【\[])((?:\/(?!\/)|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|workspace\/|artifacts\/)[^\s`<>"'，。！？；、）)】\]]+)/g;
  return [...text.matchAll(pattern)].flatMap((match) => {
    const value = match[1].replace(/[.,;:!?]+$/, "");
    return isLocalReference(value)
      ? [{ start: match.index! + match[0].indexOf(match[1]), value }]
      : [];
  });
}

export function localReferences(text: string) {
  const values = localPathSpans(text).map((item) => item.value);
  // Inline code, quoted paths and Markdown destinations also support spaces.
  for (const match of text.matchAll(
    /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|\]\(<([^>\n]+)>\)|\]\(([^\n]+?)\)/g,
  )) {
    const value = match.slice(1).find((part) => part !== undefined)!;
    let decoded = value;
    if (match[4] !== undefined || match[5] !== undefined) {
      try {
        decoded = decodeURIComponent(value);
      } catch {
        /* literal filename */
      }
    }
    if (isLocalReference(decoded)) values.push(decoded);
  }
  return [...new Set(values)];
}
