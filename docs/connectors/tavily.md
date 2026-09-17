# Tavily connector

Connect in **Settings → Connectors → Tavily** using an API key from
[app.tavily.com](https://app.tavily.com). The default endpoint is
`https://api.tavily.com`; a user-configured proxy is supported. The key is
stored through OS encryption. `GET /usage` verifies it without a search.

## Tools

| Tool | Official API | Behavior |
|---|---|---|
| `web_search` | `POST /search` | Basic search; query, up to 20 results, topic, time range and domain filters. Full responses over 1,800 UTF-8 bytes are saved. |
| `web_fetch` | `POST /extract` | Extract 1–5 URLs as Markdown. Every response, including short pages and failed URLs, is saved together. |
| `web_research` | `POST /research` | Submit a paid deep research task with `input` and optional `model` (`mini`, `pro`, `auto`). Returns a durable local handle, not the report. |
| `web_research_status` | `GET /research/{request_id}` | Query the same handle; `wait_seconds` is 0–30, default 5. Pending jobs can be queried again across turns and app restarts. Completed reports are saved once and reused. |

For saved search/extract results, `resultPath` and `rawResultPath` precede a
single preview of up to 500 characters for the entire response. `read` uses line offsets:
start with `offset: 1, limit: 200`, then continue at the next unread line.
Long lines are wrapped for reading; `rawResultPath` preserves exact content.
Secrets are redacted before any result is saved. If saving search/extract fails,
`storage_error` is explicit, with a bounded preview and `recoverable: false`.
Restore storage before retrying retrieval; never resubmit a research task automatically.
Success and error results use the same output management, including research errors.

For `web_fetch`, omit `query` to get extracted page text. A supplied `query`
returns relevant snippets (default maximum 3 per source, 500 characters each).
The inline envelope and saved result identify `contentMode`, `sourceComplete`
(no guarantee of the entire original page), and `extractionPartial` (failed URLs).
Reading a saved snippet file cannot recover missing source content; call again
without `query` for extracted text.

Research uses JSON polling, not SSE. Each HTTP call has its own timeout; there
is no 120-second lifetime limit on the remote job. Handles are scoped to the
conversation and saved connection revision. Saving an unchanged normalized URL and key preserves the revision, including
after startup validation failure. Changing the URL/key or removing the connection
invalidates access through its old handles; already saved reports remain local.
Stopping a local run stops polling but does not cancel the remote task. No
background polling or notifications occur after a status call returns.

Creation is journaled before dispatch and never automatically retried. Replaying
the same tool call returns its existing handle. An uncertain response returns
`submission_unknown`: check the account before creating another paid task.
A completed report that fails to save returns `storage_error`; query the same
handle again to retry saving, not `web_research` to resubmit. A failed remote job
returns `research_failed`. Transient errors on search/extract/status reads can retry, including failures
while transferring the response body. Research creation never retries a body failure.

All HTTP bodies are capped at 8 MiB of actual streamed bytes, even without a
reliable Content-Length. Redirects do not forward credentials. Network, quota,
authentication and rate-limit errors are returned as explicit tool statuses.

## Skills

The bundled `tavily-research` is WorkLens-authored guidance for these tools.
It is limited to explicit deep research and multi-source report requests.
Ordinary questions use search/extract. User-owned local skills
are untouched.

Official contracts: [Create research](https://docs.tavily.com/documentation/api-reference/endpoint/research),
[Get research status](https://docs.tavily.com/documentation/api-reference/endpoint/research-get).
