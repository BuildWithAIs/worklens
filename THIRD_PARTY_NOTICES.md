# Third-party software

WorkLens is distributed under the MIT license. It uses the public npm packages listed in `package-lock.json`.

| Software | License | Purpose |
| --- | --- | --- |
| Pi coding-agent / pi-ai / pi-agent-core 0.85.1 | MIT | Agent runtime, model providers, sessions and tools |
| Electron | MIT | Desktop runtime; includes Chromium and Node.js with their own notices |
| React / React DOM | MIT | User interface |
| Tailwind CSS | MIT | Styling |
| Lucide | ISC | Interface icons |
| react-markdown / remark-gfm / rehype-highlight | MIT | Safe Markdown rendering |
| Zod | MIT | Main-process input validation |

Dependency license files remain with the distributed npm packages. Electron's LICENSE and LICENSES.chromium.html are retained in the packaged application. The lockfile records exact transitive versions. No Pi reference repository source is bundled as application code.
