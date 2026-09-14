# Connector code organization

Office integrations live under `src/main/connectors/<service>/`. Local file and shell tools remain in `src/main/tools.ts`; model providers remain separate. A connector owns its authentication, API protocol, validation, operation schemas, tool descriptions and domain-specific output handling.

## Current integration surface

- `types.ts` defines the small main-process `Connector` interface: initialization, a non-secret configuration key, tool names and definitions, instructions, and redaction.
- `registry.ts` aggregates these methods for the Agent. Configuration changes rebuild the session runtime without discarding its history. Only enabled connectors contribute instructions and active tool names.
- `index.ts` explicitly assembles the installed connectors and their dependencies. There is no dynamic plugin loading or dependency injection framework.
- `ipc.ts` collects typed settings request handlers and their schemas. The application entry point still validates the IPC sender and input before dispatch. Shared request and UI contracts stay in `src/shared/contracts.ts`.
- `confluence/index.ts` adapts the existing Confluence service to this interface. Its domain modules stay together; they are not promoted to generic infrastructure just because another connector may eventually need similar functionality.

The renderer maintains a separate UI-only `components/worklens/connectors/catalog.tsx`. It maps display metadata to settings components and public connection information. The common connections page has no service-specific branches. Renderer modules must not import main-process connector implementations or credentials.

## Adding another connector

1. Implement its service under `src/main/connectors/<service>/` and expose a `Connector` adapter.
2. Register it in the main-process composition, add explicit validated settings requests in `ipc.ts`, and add their contracts to `src/shared/contracts.ts`.
3. Add its settings component and UI catalog entry.
4. Put service tests and fixtures in `tests/connectors/<service>/`, desktop acceptance tests in `tests/e2e/connectors/`, and browser UI tests in `tests/ui/connectors/`.

Tools use service-prefixed names. Their `details.status` uses `success` or `accepted` for successful results; other statuses are projected as errors through the Pi tool-result hook. Tool and credential specifics stay inside each connector. Extract shared scheduling, journaling, cursor storage or result-budget helpers only when a second implementation demonstrates the common requirements.

## Compatibility

This source reorganization preserves the existing `confluenceSave`, `confluenceTest`, `confluenceRemove` and bootstrap contracts. It also preserves the encrypted `confluence.json` filename, session data, operation journals, cursor records, and artifact/index paths. Code directories do not determine user-data locations. The existing `confluence` artifact subdirectory remains unchanged; a later connector can add a source parameter without relocating existing files.

See [Confluence behavior and validation](confluence.md).
