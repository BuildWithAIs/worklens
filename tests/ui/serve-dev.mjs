import { resolveConfig } from "electron-vite";
import { createServer } from "vite";

// Exercise React StrictMode as it runs in the desktop development renderer.
const { config } = await resolveConfig({}, "serve");
config.renderer.server = { ...config.renderer.server, host: "127.0.0.1", port: 4173, strictPort: true };
const server = await createServer(config.renderer);
await server.listen();
