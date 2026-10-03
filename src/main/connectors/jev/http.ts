import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionSnapshot } from "./connection";
import { requestGate } from "../request-gate";

const MAX_RESPONSE = 1024 * 1024;

export class JevHttp {
  private gate;
  constructor(
    private readonly connection: ConnectionSnapshot,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.gate = requestGate(
      "Jev",
      connection.settings.url,
      connection.token,
      fetcher,
    );
  }
  async request(
    path: "/v1/models" | "/v1/systemone",
    payload?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // This timeout starts after consent, not while the user is reviewing it.
    const combined = AbortSignal.any([
      this.connection.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(60_000),
    ]);
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted();
      const response = await this.gate.fetch(
        combined,
        payload !== undefined,
        () => new Error("Jev is busy. Try again later."),
        () =>
          this.fetcher(`${this.connection.settings.url}${path}`, {
            method: payload === undefined ? "GET" : "POST",
            headers: {
              authorization: `Bearer ${this.connection.token}`,
              accept: "application/json",
              ...(payload !== undefined
                ? { "content-type": "application/json" }
                : {}),
            },
            body: payload,
            redirect: "manual",
            signal: combined,
          }),
      );
      const limited = this.gate.limit(response);
      if (limited) {
        const wait = limited.delayMs;
        await response.body?.cancel();
        if (attempt >= 2 || wait > 10_000)
          throw new Error("Jev is busy. Try again later.");
        await delay(wait, undefined, { signal: combined });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Do not echo an upstream body that could contain credentials or input text.
        if (response.status >= 300 && response.status < 400)
          throw new Error(
            "Jev returned a redirect. Credentials and data were not forwarded.",
          );
        throw new Error(`Jev returned HTTP ${response.status}.`);
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE) {
        await response.body?.cancel();
        throw new Error("Jev response exceeds the size limit.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Jev returned an empty response.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE)
            throw new Error("Jev response exceeds the size limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      combined.throwIfAborted();
      try {
        return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      } catch {
        throw new Error("Jev returned invalid JSON.");
      }
    }
  }
}
