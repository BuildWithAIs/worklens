# Tavily connector

Connect in **Settings → Connectors → Tavily** using an API key from
[app.tavily.com](https://app.tavily.com). The default endpoint is
`https://api.tavily.com`; a user-configured proxy is supported. The key is
stored through OS encryption. `GET /usage` verifies it without a search.

## Tools

| Tool | Official API | Behavior |
|---|---|---|
| `web_search` | `POST /search` | Basic search; query, up to 20 results, topic, time range and domain filters. Saves the full response and returns an ordered source index with bounded excerpts. |
| `web_fetch` | `POST /extract` | Extract 1–5 URLs as Markdown. Saves the full response, separate page files, and an index of successful and failed URLs. |
| `web_research` | `POST /research` | Submit a paid deep research task with `input` and optional `model` (`mini`, `pro`, `auto`). Returns a durable local handle, not the report. |
| `web_research_status` | `GET /research/{request_id}` | Query the same handle; `wait_seconds` is 0–30, default 5. Pending jobs can be queried again across turns and app restarts. Completed reports are saved once and reused. |

Successful search/extract calls return a lightweight index rather than a prefix
of the response JSON. The envelope includes:

- `resultPath`: the index file, not the combined page bodies.
- `rawResultPath`: the complete API response, including fields omitted from the index.
- `totalResults`, `results`, `resultsTruncated`: the entry count, entries that fit
  inline, and whether more entries remain in the index. Fetch counts include failures.
- `nextOffset`: the first line of the first entry not shown inline; omitted when
  all entries fit. This is a local file line offset, not remote API pagination.
- `rawIndexPath`: present when the display index is wrapped, preserving exact
  URLs and paths for programmatic reading. The raw API path is also in the index
  header and may be omitted inline when data-root paths consume too much space.

Use `read(path=resultPath, offset=nextOffset, limit=40)` to browse more entries,
then follow the next offset returned by `read`. Start at 1 to reread the index.
Display lines are wrapped at 200 UTF-8 bytes, keeping 40 lines around 8 KiB.
Inline entries share a 1,800 UTF-8 byte budget with the envelope; whole entries
are omitted when they do not fit. URLs are never shortened to fit inline.

Search entries preserve the upstream ranking and contain `id`, `title`, `url`,
`score` (when provided), `excerpt`, and `excerptTruncated`. Titles and excerpts
are whitespace-normalized copies of upstream text, limited to 120 and 240 UTF-8
bytes respectively without splitting Unicode characters. Truncated titles have
`titleTruncated: true`. This is deterministic code: there is no extra LLM call,
search request, reranking, or generated summary. Full originals remain in the
saved response even for short search results.

Fetch entries contain `id`, `url`, and `status`. Successful entries also have
their own `resultPath`, `rawResultPath`, and `totalLines`. Read the selected page
at `offset: 1, limit: 40` and continue as needed. Each page is stored as Markdown
with real newlines; its raw file preserves exact extracted text before wrapping.
Failed entries have an error excerpt and no page path. To read page 5, consult
the index and open its file directly; do not read through pages 1–4.

Secrets are redacted before any result is saved. If saving search/extract fails,
`storage_error` is explicit, with a bounded preview and `recoverable: false`.
Restore storage before retrying retrieval; never resubmit a research task automatically.
Errors and research responses retain bounded output management. Large errors
are saved with a short preview and recovery paths; research reports still use
their existing Markdown result paths.

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
