# Desktop UI consistency and regression audit

Verified locally on macOS with Node 24 on 2026-09-12. All model and desktop tests use fixtures, local model services, and isolated temporary data.

## Results

| Check | Result |
| --- | --- |
| Build and TypeScript | Passed |
| Unit/integration suite | 37 passed; 1 Windows-only test skipped |
| Browser UI suite | 22 passed |
| Electron suite | 3 passed; 1 Windows packaged-runtime test skipped |
| Diff whitespace check | Passed |

Browser coverage includes model setup navigation, unavailable models, settings/provider workflows, chat editing/copying, timestamps, activity timing/progress, usage, light/dark themes, 1280px and 390px style comparisons, startup material, and reduced motion/transparency. Electron covers setup, file tasks, restart, forced-process recovery, concurrent usage, cancellation and deletion. Native minimum width is 850px; 390px is additional renderer stress coverage.

## Corrections

- Replaced black accent-based focus rings with a shared neutral focus token; shared controls use a 2px ring. Error and destructive states retain semantic colors.
- Centralized selected-navigation and hover colors for chat and settings, and normal/hover scrollbar colors. Scrollbars share transparent tracks, a 10px outer width, and a rounded thumb with a 2px inset.
- Standardized text input, textarea, chat composer and edit-composer text at 14px across breakpoints.
- Excluded the tagged settings heading from legacy global heading rules so its intended page-title scale applies consistently.
- Fixed narrow settings navigation flex sizing: all categories and Back to app remain visible after keyboard navigation.
- Removed the experimental heavy blur from shared dialogs; ordinary dialogs and legacy modal backdrops use the same theme-aware overlay token. Full-window settings remain transparent-backed.
- Applied reduced-transparency fallback to settings navigation as well as chat navigation; verified reduced-motion behavior.

## Intentional differences

Chat content remains 14px regular with 15px section headings and medium emphasis. Settings page titles use 26px; secondary labels, counters and timestamps remain smaller. Code retains monospace. Image previews retain their dark viewing surface. These are functional hierarchy differences, not competing defaults.

## Limits

No live cloud-provider authentication or billing verification was performed. Windows-specific behavior and packaged Windows runtime were skipped on macOS. Browser screenshots verify layout and theme styling, not native macOS wallpaper compositing. No claim is made that every possible content length or OS setting has been exhaustively tested.
