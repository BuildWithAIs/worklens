const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Known secrets and their JSON-escaped forms, replaced in one pass. Views are
// redacted on every streaming update, so the pattern is compiled only when a
// new secret is learned. Secrets are never forgotten: transcripts can still
// contain a credential after it is removed or replaced.
export class SecretSet {
  private values = new Set<string>();
  private pattern: RegExp | null | undefined = null;
  add(value: string) {
    if (!value || this.values.has(value)) return;
    this.values.add(value);
    this.pattern = undefined;
  }
  redact(text: string) {
    if (this.pattern === undefined) this.pattern = this.compile();
    return this.pattern ? text.replace(this.pattern, "[redacted]") : text;
  }
  private compile() {
    const forms = new Set<string>();
    for (const secret of this.values) {
      forms.add(secret);
      forms.add(JSON.stringify(secret).slice(1, -1));
    }
    // Longest first, so a secret containing another is replaced whole.
    return new RegExp(
      [...forms]
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join("|"),
      "g",
    );
  }
}
