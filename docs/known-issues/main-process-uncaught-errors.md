# Known issue: uncaught main-process errors show a crash dialog

Status: open. Temporary note; remove it once the safety net below lands or the issue is tracked elsewhere.

## Problem

The main process registers no `uncaughtException` or `unhandledRejection` handler (`src/main` only listens for `disconnect` in `image-decoder.mjs`). Any error that escapes every `try/catch` reaches Electron's default handler, which shows "A JavaScript error occurred in the main process" and abandons whatever the main process was doing.

Most request failures never get there: callers catch them and the UI reports them where the request was made, for example in the chat message, connector tool results, MCP and proxy connection tests (see `src/shared/run-error.ts`). The dialog appears only when a code path lets an error escape its caller.

## Example that was fixed

When a proxy bypass routed a host directly, the Undici agent's custom `connect.lookup` answered synchronously. Node connects inside the lookup callback, so a connect that failed at once (`EADDRNOTAVAIL` after a network change) threw before Undici attached its error handler. The error became an uncaught exception, and WorkLens showed the crash dialog on launch.

Fixed in `src/main/network-proxy.ts` (`bypassLookup` now answers on `process.nextTick`, as DNS does), with a regression test in `tests/network-proxy-routing.test.ts`. The failure now reaches the feature that made the request as an ordinary network error.

## Remaining risk

The fix covers only that path. Another path that lets a network error escape would still show the dialog, although the request it belongs to is already lost and no app state is affected.

## Proposed safety net

Register both handlers once at startup in `src/main/index.ts`:

- Errors with network codes (`EADDRNOTAVAIL`, `ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`): log the code without request details or secrets and keep running.
- All other errors: keep a visible failure. Ignoring them could leave stores or the usage database half-written.
- No generic network toast: the feature that made the request already reports its failure, and a toast would repeat it, often several times while the network is unstable.

Add tests that an escaped network error keeps the process running and that other errors are still surfaced.
