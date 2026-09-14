import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: "dist/main" } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwind()],
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    build: { outDir: "dist/renderer", minify: "esbuild" },
  },
});
