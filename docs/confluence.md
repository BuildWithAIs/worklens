# Confluence integration

WorkLens connects to one user-configured Confluence site. All requests and credentials stay in the main process. The model receives two tools, `confluence_read` and `confluence_write`; operation contracts remain independently validated inside `request`. The registered tools carry small discovery schemas, filtered by deployment, instead of the complete operation union. Before using an operation, call `confluence_read` with `{"request":{"operation":"describe_operation","name":"search"}}` (substitute the operation name). It returns that operation’s exact input schema. Unknown fields and invalid arguments still fail runtime validation before any request.

This implementation delivers the first everyday read/write and document-publishing increment discussed in [issue #2](https://github.com/BuildWithAIs/worklens/issues/2), plus additional lifecycle and collaboration operations. It does **not** close the comprehensive issue. The remaining scope is explicitly listed below; missing implementation is not presented as a platform limitation.

## Setup

Open **Settings → Connections** and choose **Connect Confluence**. Configured Confluence appears in the **Connected** group; choose **Manage Confluence** to change settings or disconnect. The catalog, search/filter controls, brand icons and configuration dialog share the provider settings components and theme tokens. See the [Connections catalog](screenshots/confluence-settings.png) and [configuration dialog](screenshots/confluence-dialog.png) captured by the desktop acceptance test.

- **Data Center:** enter the site URL (including a context path such as `/confluence`) and personal access token. WorkLens sends Bearer authentication.
- **Cloud, classic token:** enter the site URL, account email and API token. WorkLens uses Basic authentication and defaults an empty context path to `/wiki`.
- **Cloud, scoped token:** also select the scoped token type and provide the site's Cloud ID. Requests use `https://api.atlassian.com/ex/confluence/{cloudId}/wiki`; source links still point to your site. Validation first checks the site's public `/_edge/tenant_info` endpoint to ensure that the URL and Cloud ID match, without sending credentials to that endpoint.
- **Save** automatically checks the authenticated identity using `/rest/api/user/current` before enabling tools; the optional **Test connection** button uses the same check. A scoped token may need additional permission for this check. Missing settings, anonymous responses, authentication failures, redirects and unreachable services do not enable tools. A failed validation leaves the supplied credentials encrypted for correction, with tools disabled. Saving replacement settings also suspends the previous connection's tools and requests.
- Startup revalidates saved credentials before enabling tools, including older configurations. An offline or failed check leaves the connection disabled; save again to retry. Successful validation establishes connectivity and authenticated identity, not permission for every operation. There is no periodic background health check.

Token input is cleared after saving. Leaving it blank preserves the existing token only for the same URL, deployment, email, token type and Cloud ID. Changing account/site requires re-entering it. Disconnecting deletes the saved connection, aborts in-flight requests and invalidates outstanding authorization and pagination. Downloaded files and conversations remain.

The token is encrypted with Electron safeStorage. There is no plaintext/Base64-only fallback. Decryption failures preserve the original file. Credentials, including encoded Basic authentication, are redacted from tool output and errors. Connection configuration is separate from Pi model-provider credentials.

## Everyday examples

- “Find pages updated this week in the ENG space and summarize them with links.”
- “Read this page and its recent comments.”
- “In the deployment guide, replace Node 22 with Node 24 and preserve the rest.”
- “Publish `/project/notes/meeting.md` under this parent page, including these two images.”
- “Download this attachment to the desktop.”
- “Export this page to Markdown with these selected attachments.”

The model uses CQL for searches; filters and sorting belong in CQL. For example:

```json
{"request":{"operation":"search","cql":"space = \"ENG\" AND lastmodified >= now(\"-7d\") ORDER BY lastmodified DESC","limit":25}}
```

To prepare an exact edit, read storage rather than round-tripping Markdown:

```json
{"request":{"operation":"read_page","page":"12345","representation":"storage"}}
```

```json
{"request":{"operation":"edit_page","page":"12345","expectedVersion":17,"edits":[{"find":"<p>Node 22</p>","replace":"<p>Node 24</p>","expectedMatches":1}]}}
```

Only text expressly matched by the edits changes. Empty replacement is allowed. Ambiguous/missing matches fail. Whole-page replacement is a separate `replace_page` operation. Storage input is explicit; Markdown is never heuristically treated as HTML. Unsupported macros are exposed as preserved source when reading, not silently discarded. Version conflicts require a fresh read and newly prepared changes.

Internal page links with IDs retain a site URL and anchor. Title-only references retain their title, space and anchor for subsequent search, with a warning instead of an invented address. Attachment links retain an attachment reference; exports rewrite selected attachments to local paths and unselected attachments to the source page. Unsupported links and cross-page attachment references retain their source markup with a warning. Resolving every link does not trigger additional API requests.

Data Center historical reads use `status=historical` when a version is requested; if that resource is absent, a current-page fallback is accepted only when its version matches exactly. Cloud and Data Center responses with an unexpected requested version are rejected before comparison or restoration.

`publish_markdown` accepts an absolute or runtime-relative Markdown `filePath` and an explicit `assets` list of `{reference,filePath}`. Each reference must match the Markdown link/image target. Selected files are snapshotted before authorization; local images without a mapping fail before publishing. Files are uploaded as attachments and Markdown links are rewritten. A failed asset upload preserves the new page and successful attachments and returns per-file outcomes; retry the failed attachment instead of republishing the page.

## Operation matrix

“Implemented” means an adapter and validation exist. It does not mean live validation has been performed against every deployment/version. The `capabilities` operation describes the configured deployment and excludes whole operations not implemented for Data Center. Individual options still have deployment checks.

| Category | Operations | Cloud | Data Center |
| --- | --- | --- | --- |
| Identity/search | `current_user`, `search` (CQL) | Implemented | Implemented |
| Space discovery | `list_spaces`, `read_space` | v2 | REST content API |
| Navigation | `list_children`, `list_ancestors`, `list_descendants` | v2 | REST content API |
| Documents | `read_page`, `create_page`, `edit_page`, `append_page`, `replace_page`, `rename_page` | v2 pages/blogposts | REST content API |
| History | `list_versions`, `compare_versions`, `restore_version` | v2 | REST content API |
| Comments | `list_comments`, `read_comment`, `add_comment`, `edit_comment`, `delete_comment` | Footer and inline replies; v2 | Footer writes; inline reads depend on deployment |
| Inline review | `add_inline_comment`, `resolve_comment` | v2, with version/selection checks | Not implemented |
| Labels | `list_labels`, `add_labels`, `remove_label` | v2 reads / v1 writes | REST content API |
| Attachments | `list_attachments`, `read_attachment`, `download_attachment`, `upload_attachment`, `delete_attachment` | v2 metadata / v1 transfer | REST content API |
| Publishing/export | `publish_markdown`, `export_page` | Implemented | Implemented |
| Properties | `list_properties`, `read_property`, `set_property`, `delete_property` | v2 | REST content API |
| Restrictions | `read_restrictions`, `list_restriction_subjects`, `read_operations`, `add_restriction`, `remove_restriction` | v1 restrictions / v2 operations | REST content API |
| Templates/people | `list_templates`, `read_template`, `search_users`, `list_groups`, `list_group_members` | v1 | REST API; user-search CQL depends on deployment |
| Watches | `read_watch`, `set_watch`, `read_space_watch`, `set_space_watch` | v1 | REST API |
| Tasks | `list_tasks`, `read_task`, `set_task_status` | v2; only status is editable | Not implemented |
| Likes | `list_likes` | v2 reads | Not implemented |
| Movement | `move_page` (append/before/after) | v1 move | REST move endpoint; verify server version |
| Lifecycle | `trash_page`, `restore_page`, `delete_page_permanently` | v2; verify deployment behavior | REST content API |
| Copy | `copy_page` with explicit attachments/labels/restrictions choices | v1 native copy | Not implemented |
| Archive | `archive_page`, `read_long_task` | v1 asynchronous archive; poll task | Archive not implemented |

Deletion/restoration currently rejects pages with descendants instead of silently expanding the affected set. Restriction changes affect one explicitly selected user/group and one direct restriction; they do not remove inherited access constraints. Use ancestor reads and paginated restriction-subject reads to inspect inherited context. Confluence remains authoritative for account and content permissions.

Pending scope in #2: explicit bounded batch workflows and tree copies, unarchive, personal favorite mutations, like mutations where a documented API supports them, Data Center-specific advanced collaboration/lifecycle adapters, and broader live capability verification. Native PDF/Word exports and marketplace-specific rendering are not implemented. Cloud whiteboards/databases and global administration are outside this integration's scope.

## Files and output

Default files are saved under `<data root>/artifacts/files/<conversation ID>/confluence/<transfer ID>/`. A file card provides **Open**, **Show in folder**, and **Save as** without expanding tool traces. Disconnecting does not delete artifacts.

`destination.directory` chooses a directory and automatically numbers colliding names. `destination.path` chooses an exact filename and fails if it exists. `overwrite: true` explicitly requests replacement of an existing file. Save-as uses the OS file dialog's overwrite confirmation. Relative paths resolve against the displayed initial runtime directory, and `~/` expands to the user home.

Transfers stream to a temporary file in the destination directory, then commit only after completion. Exclusive filesystem links prevent no-overwrite collisions, including concurrent downloads. Overwrites preserve the old file until the new one is complete; the tool checks the identity of the file captured before the transfer. Cancellation removes the current partial file. No automatic archive extraction or execution occurs.

Files are limited to 100 MiB; a Markdown publication is limited to 2 MiB of text and 100 MiB of explicitly selected assets (at most 30). Exported Markdown/HTML preserves source URL, page version and export timestamp; attachments use a distinct relative assets directory. Unselected/failed attachments retain a source-page link. HTML export permits basic formatting and safe links, with scripts disabled; it is not the native Confluence renderer.

List results contain bounded summaries plus continuation/completeness and a `resultPath` containing the full original records. Cursors are persisted per session for seven days and survive application restart. Older encrypted connection files acquire a stable identity through an atomic migration that preserves their ciphertext. Saving/changing or disconnecting the connection invalidates old cursors; they also cannot cross sessions or queries. Expired cursors return instructions to restart the original query and deduplicate by resource ID. Page observations require a fresh read after restart before editing.

Bodies use `offset`, `length`, and `nextOffset`. Recovery metadata and `resultPath` precede content, so Pi’s 2,000-character compaction input cutoff preserves them for summarization. Results above 1,800 characters get a retrieval file; inline output is bounded separately. Result-file failures preserve the operation outcome and include `retrievalError`; a successful remote mutation is never reported as failed solely because its local result file could not be saved. Model summaries are still lossy: use the returned file handle to recover exact content.

If saving the final exported document fails, the result reports `partial` with all successful attachments and a document-specific failure. Retrying only the document avoids redownloading successful attachments.

## Execution semantics

- Remote reads are limited to four simultaneous operations. Remote writes are serialized across conversations; other clients are protected through server versions where available.
- Validated connections expose all implemented read and write operations for their deployment, without a WorkLens access mode or per-operation approval dialog. Confluence account permissions still apply. Account/site changes invalidate pending operations. Legacy access settings are removed on load while preserving encrypted credentials.
- Read requests retry bounded transient failures and respect Retry-After (long waits are returned to the caller). Mutations are never automatically retried after a network/5xx failure.
- A journal records pending/completed/uncertain writes. Identical mutations within one run/connection are deduplicated, including ambiguous outcomes. This is not a server-side idempotency guarantee or a cross-request transaction. After an uncertain result, read the target before any new attempt.
- If the pending journal cannot be saved, no remote mutation is sent. If saving the final journal fails, the tool preserves the received remote outcome and includes `journalWarning`; failure logging also cannot replace an uncertain remote outcome with a local storage error. The pending record remains, so identical retries (including after service restart) return `unknown` without resubmitting the mutation.
- Versioned page/comment/property writes use expected versions. Some APIs (deletion, moving, restrictions, tasks and file upload) do not expose an atomic compare-and-swap: preflight checks reduce stale operations but cannot eliminate races with external clients.
- Ordinary page edits prepare changes from one full-page GET and use the PUT version to detect concurrent edits, without redundant full-page preflight reads. Restoring a version additionally reads the requested historical body. Raw storage reads skip Markdown conversion.
- Attachment redirects never receive the Confluence Authorization header after redirecting. API requests do not silently follow login/SSO redirects. HTTPS is required for Cloud and redirected downloads; explicitly configured intranet Data Center HTTP sites are allowed.

## Code organization

`service.ts` registers the two tools and coordinates execution. `discovery.ts` owns the filtered catalog and on-demand contracts; `read.ts` and `write.ts` exhaustively dispatch inferred request unions. Write handlers are grouped by pages, comments, attachments, collaboration, and lifecycle. `operation-context.ts`, `continuations.ts`, `mutations.ts`, `results.ts`, and `transfers.ts` separately own authorization/read state, persistent cursors, write journaling, model output, and files. Adapter response records remain a remote-data boundary; page and list structure are validated before use.

## Validation

Tests use synthetic credentials and temporary directories. `tests/confluence-fixture.ts` hosts a local REST service. `tests/confluence*.test.ts` exercise encrypted persistence, strict contracts, source isolation, pagination, macro preservation, stale versions, unrestricted tool registration and legacy settings migration, uncertain writes, transfer collisions/cancellation, publication partial failures, Cloud payloads and real Pi registration/error handling. Context regressions exercise Pi’s actual compaction serializer, persistent/expired cursors, schema budgets, deployment filtering, existing-session refresh, and final-export storage failure. `tests/e2e/confluence.spec.ts` runs Electron Settings, connection testing, encrypted restart, a real Pi download and visible artifact card.

Live validation: **not performed**. No company network, paid Cloud account or real Confluence token is required for automated tests. The API adapters should be smoke-tested against authorized Cloud and target Data Center versions before claiming full deployment support. Automated fixtures do not certify undocumented or version-dependent behavior.

## API references

- [Cloud basic authentication](https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/)
- [Cloud scoped tokens](https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/)
- [Data Center personal access tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
- [Cloud REST v2](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Cloud REST v1](https://developer.atlassian.com/cloud/confluence/rest/v1/intro/)
- [Data Center REST](https://developer.atlassian.com/server/confluence/rest/v931/intro/)
