# Jira integration

WorkLens connects to **one user-configured Jira site** through `jira_read` and `jira_write`. It supports Cloud and self-hosted Data Center, with the same connection UI and direct-write interaction as Confluence. There are no per-operation approval dialogs, access-mode toggles or model-supplied confirmation flags. Jira account permissions remain authoritative.

This implements the daily-work categories from [issue #1](https://github.com/BuildWithAIs/worklens/issues/1). The design decisions agreed on September 14, 2026 supersede that issue's original multiple-instance and per-operation approval requirements. No organization URLs, account names, project names or custom-field IDs are built in.

## Setup

Open **Settings → Connectors → Connect Jira**.

| Deployment               | Settings                                  | Authentication / API                                                    |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| Data Center              | Site URL and personal access token (PAT)  | Bearer token; platform REST v2 and Agile REST 1.0                       |
| Cloud, classic API token | Site URL, Atlassian email, API token      | Basic email/token; platform REST v3 and Agile REST 1.0                  |
| Cloud, scoped API token  | Site URL, email, token; optional Cloud ID | Basic email/token through `https://api.atlassian.com/ex/jira/{cloudId}` |

Cloud ID is discovered from the site's public `/_edge/tenant_info` endpoint when omitted. Manual IDs are validated against that same site. This discovery request carries no credentials and follows no redirects. Source issue links always point to the configured site, not the API gateway. Jira site URLs do not acquire Confluence's `/wiki` suffix.

The Data Center compatibility target is the **Jira 9.12 REST contract and newer deployments retaining those APIs**, with PAT authentication and paginated create metadata. Older Server releases, browser-session/SSO-cookie authentication and organization-specific authentication gateways are not compatibility targets. Agile operations require Jira Software; a successful identity check does not imply access to a board or permission to manage a sprint/version. Worklogs require time tracking to be enabled.

Save automatically validates `/myself`; anonymous or invalid identities do not enable tools. Startup revalidates saved credentials. Failed saves retain encrypted settings for correction and disable tools. Blank token input retains the existing token only for the same site, deployment, email, token type and Cloud ID. Changing the connection aborts old requests and invalidates continuations/previews. Disconnect removes the credential file and keeps conversations and downloaded files.

Credentials are encrypted with Electron safeStorage in `jira.json`; there is no plaintext fallback. Secrets and encoded Basic credentials are redacted from results, errors and operation records. Renderer/bootstrap contracts never return tokens. Cloud requires HTTPS; explicitly configured intranet Data Center HTTP URLs are accepted. API redirects are rejected. Attachment redirects can go to HTTPS download hosts but never receive the Jira Authorization header.

## Tool discovery and fields

The initial tools carry small operation catalogs, not the full collection of schemas. Discover the exact operation contract before using it:

```json
{ "request": { "operation": "describe_operation", "name": "create_issue" } }
```

`capabilities` lists available implementations and deployment caveats. `server_info` and `permissions` provide remote context. Unknown request fields fail validation before any request; `instance`, `token` and `confirmed` are not tool arguments.

Use `list_projects`, `list_issue_types`, `create_metadata`, `edit_metadata`, `list_fields` and `list_transitions` to obtain native IDs and required fields. Field values use Jira's native shapes, for example:

```json
{
  "request": {
    "operation": "create_issue",
    "project": "ENG",
    "issueType": "10001",
    "fields": {
      "summary": "Investigate login failure",
      "priority": { "id": "2" },
      "customfield_12345": 5
    },
    "description": {
      "format": "markdown",
      "text": "**Observed:** login fails after redirect."
    }
  }
}
```

These IDs are examples, not defaults. Metadata is fetched for the actual project/type or issue before writing; it is not cached indefinitely by site URL. Missing required fields, unknown fields, invalid types, unavailable field operations and ambiguous allowed values fail instead of being silently skipped. Jira still validates plugin-specific rules and workflow validators.

System and standard custom fields can be set through `fields`, including reporter, labels, priority, due date (`duedate`), components, affected versions (`versions`), fix versions, estimates (`timetracking`), user pickers and selections. `null` explicitly clears a nullable field; `[]` clears a non-required multi-value field; omission preserves it. Native `edits` provide set/add/remove where the field's edit metadata allows it. Prefer add/remove for labels and collections to preserve unrelated changes.

Users are referenced by exact Cloud `accountId` or Data Center `name`, never guessed from display names. Search and assignable-user operations return these identities. `assign_issue` accepts `null` to unassign. `set_parent` uses `parent` by default; DC Epic Link and other supported relationship fields can be selected by their discovered field ID. Story points/board estimates use `set_estimate`, whose Agile API resolves the board's estimation configuration.

Transitions require an actual transition ID and its specific required fields. There are no hardcoded “Done” or “In Progress” workflow assumptions.

## Operation matrix

The catalog contains 49 read/preparation operations and 37 write operations.

“Implemented” describes adapter/contract coverage, not certification against live instances. Cloud and Data Center have automated fixture coverage; see the live-validation table below.

| Category            | Operations                                                                                                                                                       | Cloud                                          | Data Center                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Discovery           | `capabilities`, `describe_operation`, `current_user`, `server_info`, `permissions`, `read_operation`                                                             | Implemented                                    | Implemented                                                                                                     |
| Projects/metadata   | `list_projects`, `read_project`, `list_fields`, `list_issue_types`, `create_metadata`, `edit_metadata`, `list_priorities`, `list_resolutions`, `list_link_types` | v3                                             | v2                                                                                                              |
| Search/issues       | `search`, `read_issue`                                                                                                                                           | Enhanced JQL token pagination                  | JQL offset pagination                                                                                           |
| History             | `changelog`                                                                                                                                                      | Paginated changelog API                        | Embedded history, locally paginated; explicit incompleteness if server truncates                                |
| Comments            | `list_comments`, `read_comment`, `add_comment`, `edit_comment`, `delete_comment`                                                                                 | ADF and visibility                             | Wiki and visibility                                                                                             |
| Worklogs            | `list_worklogs`, `read_worklog`, `add_worklog`, `edit_worklog`, `delete_worklog`                                                                                 | v3                                             | v2                                                                                                              |
| Issue maintenance   | `create_issue`, `update_issue`, `assign_issue`, `transition_issue`, `set_parent`                                                                                 | Implemented                                    | Implemented                                                                                                     |
| Lifecycle           | `clone_issue`, `preview_delete`, `delete_issue`                                                                                                                  | Implemented                                    | Implemented                                                                                                     |
| Relationships       | `list_remote_links`, `link_issues`, `unlink_issues`, `set_remote_link`, `delete_remote_link`                                                                     | Implemented                                    | Implemented                                                                                                     |
| Watching/voting     | `list_watchers`, `set_watch`, `read_votes`, `set_vote`                                                                                                           | Subject to site settings/permissions           | Subject to site settings/permissions                                                                            |
| Attachments         | `attachment_settings`, `list_attachments`, `read_attachment`, `download_attachment`, `upload_attachment`, `delete_attachment`                                    | Implemented                                    | Implemented                                                                                                     |
| Filters             | `list_filters`, `read_filter`, `run_filter`, `create_filter`, `update_filter`, `delete_filter`, `set_filter_favourite`                                           | Favourite, owned and accessible search         | Favourite enumeration; direct ID access; favourite writes use documented `/rest/api/1.0/filters/{id}/favourite` |
| Boards              | `list_boards`, `read_board`, `board_configuration`, `backlog`, `board_issues`                                                                                    | Agile 1.0                                      | Agile 1.0                                                                                                       |
| Planning            | `list_sprints`, `read_sprint`, `sprint_issues`, `move_to_sprint`, `move_to_backlog`, `rank_issues`, `set_estimate`                                               | Agile 1.0                                      | Agile 1.0                                                                                                       |
| Sprint lifecycle    | `create_sprint`, `update_sprint`, `start_sprint`, `complete_sprint`                                                                                              | Agile 1.0                                      | Agile 1.0                                                                                                       |
| Releases/components | `list_versions`, `read_version`, `create_version`, `update_version`, `release_version`, `list_components`, `read_component`                                      | Implemented                                    | Implemented                                                                                                     |
| Batches             | `preview_batch`, `batch`                                                                                                                                         | Explicit bounded target set, per-item outcomes | Same                                                                                                            |

The DC v2 reference does not expose Cloud's owned-filter enumeration or accessible-filter search. Those options return `unsupported_capability` instead of substituting favourites and claiming completeness. Favourite the desired filters in Jira or supply their IDs to `read_filter`/`run_filter`. Filter update/delete is limited to the current owner's filters. Newly created filters inherit Jira's default sharing scope; returned permissions describe their visibility.

Board, sprint, release and collaboration operations may return permission errors depending on the user's role and token scopes. These are not described as unimplemented features. Global administration, workflow/permission scheme design, marketplace custom features and Jira Service Management-specific assets/SLAs/portal administration are outside scope.

## Content and files

`description`, `environment`, comment bodies and worklog comments accept explicit `markdown`, Cloud `adf`, or DC `wiki` representations. Markdown conversion supports headings, emphasis, code, links, quotes, lists, task markers and tables. Mentions use `@{accountId|Display Name}` on Cloud or `@{username|Display Name}` on DC, after identity lookup. Task markers are text checkboxes, not Jira task entities.

Native ADF/wiki is returned intact. Readable text is a convenience projection, not a lossless edit source. Whole-field changes should be prepared from the native representation so unsupported extensions/media stay intact. Markdown HTML and images that cannot be converted without loss fail with instructions to use native content; Jira media references require their native representation after attachment upload. Unknown nodes are never silently stripped from native input. Jira remains the validator for native documents and custom renderers.

Downloaded files appear as standard file cards with Open, Show in folder and Save as. Default location:

```
<data root>/artifacts/files/<session ID>/jira/<transfer ID>/
```

Use `destination.directory` for a directory with automatic name collision handling, or `destination.path` for an exact path. Existing exact paths require explicit `overwrite: true`. Transfers use temporary files; cancellation removes partial downloads. Uploads snapshot an explicitly selected regular file and reject changes during reading. WorkLens limits files to 100 MiB and honors smaller server upload limits. No archive extraction or execution occurs.

Large results have a local `resultPath` containing full original JSON, including native content. That handle and pagination metadata precede inline content so Pi compaction retains them. Internal result files do not become file cards. An output-file failure reports `retrievalError` and returns the full result inline without truncation or a nonexistent recovery path. Preserve that inline result before compaction. A successful remote mutation remains successful.

## Execution and recovery

Reads have bounded concurrency, deadlines, cancellation and transient retries, including the read-only POST JQL endpoint. Retry-After is honored; long requested delays return a rate-limit result rather than blocking indefinitely. Mutations are not automatically retried on network/5xx errors. A lost response after dispatch is `unknown`, including cancellation after dispatch.

Sprint completion closes the sprint before moving unfinished issues, preserving membership at closure. If closing fails or is uncertain, no move is sent. If moving fails after closure, the result identifies the issues and destination for separate recovery; do not complete the sprint again.

Batch identity/preview checks run with concurrency four and request only IDs and timestamps. Writes remain sequential, with a 15-minute batch deadline and the usual 30-second individual request timeout. Explicit timestamp checks still run before each item is changed.

Writes are serialized across conversations. `expectedUpdated` can check a previously read issue timestamp; comment/worklog edits and deletes require their timestamp. There is no claim of universal atomic compare-and-swap support in Jira. Preflight checks reduce stale writes but cannot eliminate races with other clients. Metadata and partial field changes prevent unrelated fields from being overwritten.

Before each remote write step, a durable operation record is saved. If that fails, the step is not sent. If final journaling fails after receiving a result, the remote result is preserved with `journalWarning`. Identical operations in the same session/run/connection are deduplicated, including after service reconstruction with that run identity. This is not cross-run/server-side idempotency.

Mutation results include an `operationId`; `read_operation` retrieves the durable outcome/steps within the same session and connection. An unfinished record remains unknown and must be reconciled by reading Jira before another attempt. A crash after a create can leave the new issue's ID unknown: search/read to reconcile, never blindly create again.

`preview_delete` captures the issue and child IDs. `delete_issue` requires that preview and an explicit child-deletion choice. `preview_batch` displays exact changes and current values and supplies an optional drift-check token for `batch`; it is a preparation operation, not a user approval dialog. Batches accept at most 50 explicitly listed issues, reject duplicate targets, return each item's outcome, and keep successful writes. Retry only failed/not-executed items; reconcile unknown items first.

Cloning explicitly selects fields, links and attachments. It does not implicitly clone child issues, comments or worklogs. If a follow-up link/upload fails, the created issue remains and the result lists the failed step for targeted recovery. Completing a sprint requires a destination for unfinished work. WorkLens uses the originating board's final column to identify completed issues, moves up to 50 unfinished issues to the chosen backlog/sprint, then closes the sprint; partial results retain completed steps. Neither workflow is a multi-request transaction.

Worklog mutations require a timezone-bearing start timestamp and seconds, and an explicit estimate policy: `leave`, `auto`, or `new` with the new remaining estimate. No organization-specific hours-per-day assumption is built in.

## Everyday workflows and validation

The connector supports these workflows through its operations:

1. Search current sprint work, read an issue and changelog/dependencies, and add a progress comment.
2. Discover bug type/required fields, create a bug, upload an image, assign a user, set a fix version and link a story.
3. Inspect backlog and estimates, rank work, move issues to a future sprint and update its goal.
4. Add a worklog with explicit remaining-estimate behavior and execute a valid resolution transition.
5. Preview a fixed set of issues, update labels/assignees, and report each partial failure.
6. Retrieve issues, history and worklogs for a requested reporting period and summarize with issue URLs, JQL/time range and completeness warnings. Summaries use the Agent, not a separate endpoint that invents metrics or reproduces native Jira report charts.

Synthetic fixtures live in `tests/connectors/jira/`. Tests exercise both platform versions, required fields, transitions, identity shapes, collection deltas, token/offset pagination, cursor isolation/restart, content formats, attachment paths, filters, boards, sprints, releases, batches, clone partial failures, encrypted configuration, failed validation, cancellation, redirects, write uncertainty and local-storage failures. Recovery tests use Pi's real compaction serializer. Desktop acceptance uses the real Pi tool path with a local model server for download and comment creation without approvals. UI tests cover English/Chinese, light/dark themes and desktop/narrow layouts.

| Validation                                                                 | Status                                    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| Automated Cloud classic/scoped authentication and v3/Agile contracts       | Local synthetic coverage                  |
| Automated DC PAT, v2/Agile contracts based on 9.12 reference               | Local synthetic coverage                  |
| Electron settings, encrypted restart, Pi read/write, file card, disconnect | Local macOS acceptance                    |
| Live Jira Cloud account                                                    | Not performed; no live token used         |
| Live Jira Data Center deployment                                           | Not performed; no enterprise account used |
| Windows/Linux desktop acceptance                                           | Not performed in this macOS workspace     |

Run `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/connectors/jira.spec.ts`, and `npx playwright test --config playwright.ui.config.ts tests/ui/connectors/jira.spec.js`. All test state is temporary; desktop tests use `WORKLENS_TEST_ROOT`.

Before claiming live deployment certification, run the six workflows on authorized disposable projects and record Jira version, product availability, authentication/token type, permissions and results in the table above. Mock coverage does not establish live account compatibility.

## Troubleshooting and API references

- Authentication errors: verify URL, email/token mode and expiry. SSO browser login URLs are not REST authentication.
- Scoped Cloud errors: check Cloud ID/site binding and token scopes for both platform and Jira Software operations.
- Required/invalid fields: fetch metadata for the exact project/type or issue; use field IDs and allowed-value IDs, not guessed translated names.
- Missing transitions: query the current workflow; validators and permission rules may differ by issue.
- Permission/404 responses: Jira can hide inaccessible issues as missing. These are not authoritative empty searches.
- Incomplete history/search: follow continuations; a DC history truncation warning must remain in any resulting report.
- Unknown/partial writes: retain the operation ID and successful item IDs; inspect Jira and retry only unresolved steps.

References: [Cloud authentication](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/), [Cloud v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/), [Cloud enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), [Cloud Jira Software](https://developer.atlassian.com/cloud/jira/software/rest/), [DC 9.12 platform contract](https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/), [DC 9.12 Agile contract](https://docs.atlassian.com/jira-software/REST/9.12.0/), [PAT authentication](https://developer.atlassian.com/server/jira/platform/personal-access-token/).
