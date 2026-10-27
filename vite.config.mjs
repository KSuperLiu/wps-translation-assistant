import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", strictPort: true },
  build: { rollupOptions: { input: { main: resolve("index.html"), pane: resolve("pane.html") } } },
});
