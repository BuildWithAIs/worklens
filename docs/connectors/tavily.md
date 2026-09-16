# Tavily (web search)

Tavily gives the agent two read-only tools: `web_search` and `web_fetch`. It needs an API key from [app.tavily.com](https://app.tavily.com).

## Setup

Settings → Connectors → Tavily → paste the API key → **Test connection** → **Save**.

- **API URL** is prefilled with `https://api.tavily.com` and can point at a proxy or gateway instead. It must be an `http(s)` address without credentials, query or fragment; a path prefix is kept. Changing the address requires entering the key again.
- **Test connection** calls `GET <API URL>/usage`, which verifies the key and reports the plan without spending search credits.
- The key is stored encrypted with the operating system's secure storage in `tavily.json` under the user-data directory, alongside `github.json` and the Atlassian files. A key whose last validation failed is retained so it can be retried or disconnected; the tools stay hidden until validation succeeds.
- Saving, testing or disconnecting changes the connector configuration key, which rebuilds the agent session runtime without discarding history.

## Tools

| Tool         | Tavily endpoint | Notes                                                                                                                                                                                                                                                                              |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search` | `POST /search`  | `query`, optional `max_results` (1–20, default 5), `topic` (`general` / `news` / `finance`), `time_range` (`day` / `week` / `month` / `year`), `include_domains`. Always `search_depth: "basic"` (1 credit). Returns title, URL, excerpt, score and, for news, the published date. |
| `web_fetch`  | `POST /extract` | 1–5 URLs as Markdown. Pages over 12 000 characters are saved under the conversation's artifacts (`files/<session>/tavily/…/<host>.md`) and returned as a preview with the path, so the agent continues with `read`. Failed URLs are listed separately.                             |

Both tools are `parallel`; every request is idempotent, so network errors, `429` and `5xx` retry up to three times (honouring `Retry-After` up to 30 s). Responses over 8 MiB are rejected.

## Failure statuses

`details.status` on the tool result, projected as errors by the Pi tool-result hook:

| HTTP      | status                                            |
| --------- | ------------------------------------------------- |
| 401       | `authentication`                                  |
| 429       | `rate_limit`                                      |
| 432 / 433 | `quota` (key or plan limit exceeded)              |
| 400 / 422 | `invalid_request`                                 |
| other     | `http`, `network`, `redirect`, `result_too_large` |

Messages carry the `Tavily 返回 <status>。<detail>` form so the renderer's `system-text` mapping translates them like the other connectors. The API key and its URL-encoded and base64 forms are redacted from every tool result and error.

## Skills

The bundled `deep-research` skill assumes a search tool and a `web_fetch` tool; it works unchanged once Tavily is connected. Until then it is better left disabled in Settings → Skills.
