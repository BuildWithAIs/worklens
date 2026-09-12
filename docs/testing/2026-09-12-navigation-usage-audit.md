# Navigation, chat and Usage regression audit

Verified on macOS with Node 24 on 2026-09-12. This covers the UI changes after PR #12. Tests use browser fixtures, local model services and isolated temporary data, not real conversations.

## Consistency review

- Chat and settings navigation share font family, 14px regular weight, selected text color, selection fill and hover tokens. A cross-surface computed-style regression guards these values.
- Global scrollbars retain the shared 10px outer width, inset rounded thumb and theme-aware hover color. Chat and settings computed styles are compared in light/dark themes at 1280px and 390px. Activity, model lists and Usage inherit these rules.
- Both Usage tabs keep the same panel height, divider position and footer text center. Desktop and narrow layouts, English/Chinese, dark mode, missing/partial data and keyboard navigation are covered. Chart colors are scoped to the Usage popover to prevent leakage into unrelated components.
- User and assistant action icons both use 14px strokes while retaining their 24px button targets. Chat body remains 14px, section headings 15px and the chat title 15px. Settings page titles intentionally retain their larger page hierarchy.
- History title fade, hover scrolling, reduced motion, loading ring and unseen completion marker are tested. A dismissed pointer menu hides its trigger even when focus returns to it; keyboard focus still reveals the trigger.
- Thinking activity shows a single compact description with the corresponding icon. Search arguments remain available, long shell commands are shortened, and settled tool status disappears after 900ms while generation continues.
- Brand mark is shared by startup and sidebar. Packaged application icons are outside this change.

- Updated both Electron suites to follow the new Usage tabs and status row; real token totals, cancellation, concurrent runs, restart and deletion assertions remain in place.

## Verification

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed |
| Unit/integration tests | 39 passed; 1 Windows-only test skipped |
| Browser UI tests | 23 passed |
| Electron desktop tests | 3 passed; 1 packaged-runtime test skipped |
| Diff whitespace check | Passed |

Representative screenshots: [home](../screenshots/chat-home-compact.png), [history unread](../screenshots/history-unread.png), [settings](../screenshots/settings-navigation.png), [Usage overview](../screenshots/usage-overview.png), [Usage details](../screenshots/usage-details.png).

## Limits

Native minimum width is 850px; 390px is renderer stress coverage. No live cloud-provider authentication or billing validation was performed. Windows-only behavior and packaged-runtime validation are not covered by this macOS run. Browser screenshots do not validate native wallpaper compositing. Unread indicators are session-local and do not persist across application restart.
