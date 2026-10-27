import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: "127.0.0.1", strictPort: true },
  build: { rollupOptions: { input: { main: resolve("index.html"), pane: resolve("pane.html") } } },
});
