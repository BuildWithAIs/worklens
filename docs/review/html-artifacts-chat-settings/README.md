# HTML artifacts, chat and settings review

Screenshots use isolated Playwright fixtures, not user conversations.

- [HTML preview, light](artifact-light.png)
- [HTML preview, dark](artifact-dark.png)
- [Source highlighting](artifact-code-light.png) — fixture intentionally includes a long source line.
- [Ordered activity](ordered-progress.png)
- [Settings, dark](settings-dark-1280.png)

Validation: typecheck and build; 45 unit/integration tests passed (1 skipped); 61 browser UI tests passed; 4 desktop tests passed (packaged Windows test skipped). Desktop usage acceptance was updated for the new truncated title display and verified separately.

Preview is static: inline CSS is supported, scripts and network resources are blocked. Chrome/Finder IPC requests and file validation are tested; actual native Chrome/Finder launches and cloud accounts were not exercised. Semantic activity summaries remain a separate feature in issue #16.
