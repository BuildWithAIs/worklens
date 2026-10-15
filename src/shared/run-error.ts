// Classifies the error text of a failed model run so the chat can present a
// title, the provider's own explanation, and next steps instead of raw JSON.
// Input is the redacted text stored on the message; history only keeps this
// string, so classification must work from text alone.

export type RunErrorKind =
  | "unavailable"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "interrupted"
  | "image_processing"
  | "auth"
  | "quota"
  | "model_missing"
  | "context_overflow"
  | "image_limit"
  | "rejected"
  | "unknown"
  | "content_filter"
  | "refusal";

export type RunError = {
  kind: RunErrorKind;
  status?: number;
  /** The provider's readable explanation, without the JSON envelope. */
  detail?: string;
  /** WorkLens error code, such as CHAT_IMAGE_REQUEST. */
  code?: string;
  raw: string;
};

const codeKinds: Record<string, RunErrorKind> = {
  CHAT_IMAGE_REQUEST: "image_limit",
  CHAT_IMAGE_DIMENSIONS: "image_limit",
  CHAT_IMAGE_SIZE: "image_limit",
};

// Ordered: the first match wins. Quota precedes rate limits because OpenAI
// reports exhausted quota as 429; context overflow precedes generic 4xx.
// Wording follows pi-ai's utils/overflow.js and utils/retry.js.
const rules: [RunErrorKind, (text: string, status: number) => boolean][] = [
  [
    "content_filter",
    (text) =>
      /content[_ ]filter|finish_reason: sensitive/i.test(text) ||
      /\bSAFETY\b/.test(text),
  ],
  ["refusal", (text) => /refused to complete/i.test(text)],
  [
    "context_overflow",
    (text) =>
      !/rate limit|too many requests|throttl/i.test(text) &&
      /prompt (?:is )?too long|prompt exceeds max length|request_too_large|context[_ ]length[_ ]exceeded|exceeds the context window|maximum context length|input token count.*exceeds|maximum prompt length|reduce the length of the messages|context window exceeds|exceeded model token limit|too many tokens|token limit exceeded/i.test(
        text,
      ),
  ],
  [
    "image_limit",
    (text) =>
      /image[^.]{0,60}(?:exceed|too large|too big|maximum|dimension)|(?:exceed|too large|too many)[^.]{0,40}image/i.test(
        text,
      ),
  ],
  [
    "quota",
    (text, status) =>
      status === 402 ||
      /insufficient[_ ](?:quota|balance|credit|funds)|quota exceeded|exceeded your current quota|billing|out of budget|usage limit reached|credit balance/i.test(
        text,
      ),
  ],
  [
    "auth",
    (text, status) =>
      status === 401 ||
      /invalid[_ ]api[_ ]key|incorrect api key|authentication[_ ]error|unauthori[sz]ed|permission[_ ]denied|invalid x-api-key/i.test(
        text,
      ),
  ],
  [
    "model_missing",
    (text, status) =>
      /model_not_found|model\b[^.]{0,80}(?:does not exist|not found)/i.test(
        text,
      ) ||
      (status === 404 && /model/i.test(text)),
  ],
  [
    "rate_limit",
    (text, status) =>
      status === 429 ||
      /rate[_ ]?limit|too many requests|resource_exhausted|throttl/i.test(text),
  ],
  [
    "unavailable",
    (text, status) =>
      status === 503 ||
      status === 529 ||
      /overloaded|service.?unavailable|too busy|high demand/i.test(text),
  ],
  [
    "server",
    (text, status) =>
      (status >= 500 && status < 600) ||
      /internal.?(?:server.?)?error|server_error|bad gateway/i.test(text),
  ],
  ["timeout", (text) => /timed? ?out|timeout/i.test(text)],
  [
    "network",
    (text) =>
      /connection error|fetch failed|network.?error|ECONN\w+|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|other side closed|certificate|upstream connect/i.test(
        text,
      ),
  ],
  [
    "interrupted",
    (text) =>
      /terminated|stream ended|ended without|websocket.?closed/i.test(text),
  ],
  ["rejected", (_, status) => status >= 400 && status < 500],
];

// These kinds are explained by their title; their raw text stays in details.
const titleOnly = new Set<RunErrorKind>([
  "network",
  "timeout",
  "interrupted",
  "content_filter",
  "refusal",
]);
const genericDetail =
  /^(?:overloaded|an unknown error occurred|internal server error|service unavailable|bad gateway|模型请求失败|the model request failed)\.?$/i;
const requestIdPattern =
  /\s*\(?\s*request[_ -]?id["']?\s*[:=]\s*["']?[A-Za-z0-9][\w-]{7,}["']?\s*\)?\.?/i;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parseBody(rest: string) {
  const start = rest.indexOf("{");
  if (start < 0) return { detail: text(rest.replace(/^\(no body\)$/i, "")) };
  try {
    const body: unknown = JSON.parse(
      rest.slice(start, rest.lastIndexOf("}") + 1),
    );
    if (!body || typeof body !== "object") return {};
    const record = body as Record<string, unknown>;
    const error =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : undefined;
    const code = Number(error?.code ?? record.code);
    return {
      detail:
        text(error?.message) ??
        text(record.message) ??
        text(record.detail) ??
        text(record.error),
      status: code >= 400 && code < 600 ? code : undefined,
    };
  } catch {
    // pi-ai truncates long bodies, which leaves invalid JSON.
    const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(rest)?.[1];
    return {
      detail: message?.replace(/\\"/g, '"').replace(/\\n/g, " "),
    };
  }
}

export function parseRunError(input: string | undefined): RunError {
  const raw = (input ?? "").trim();
  const source = raw.replace(/^Error:\s*/, "");
  const code = /^(CHAT_IMAGE_[A-Z]+)\b/.exec(source)?.[1];
  if (code) {
    const kind = codeKinds[code] ?? "image_processing";
    return { kind, code, raw };
  }

  const head = /^(\d{3})(?:\s*status code)?(?:\s*:\s*|\s+|$)/.exec(source);
  const body = parseBody(head ? source.slice(head[0].length) : source);
  const status = head ? Number(head[1]) : body.status;
  const kind =
    (source &&
      rules.find(([, matches]) => matches(source, status ?? 0))?.[0]) ||
    "unknown";
  const detail = titleOnly.has(kind)
    ? undefined
    : body.detail
        ?.replace(requestIdPattern, "")
        // Request paths such as "messages.4.content.1.image.source.base64:".
        .replace(/^[a-z_]+(?:\.[\w[\]]+){2,}:\s*/i, "")
        .replace(/\.{3} \[truncated \d+ chars\]$/, "…")
        .trim();
  return {
    kind,
    status,
    detail: detail && !genericDetail.test(detail) ? detail : undefined,
    raw,
  };
}
