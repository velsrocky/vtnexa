import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],

  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 500,
    rolldownOptions: {
      output: {
        // Rolldown (Vite 8) requires the function form — object form is
        // Rollup-only and fails the build (manualChunks is not a function).
        manualChunks: (id: string) => {
          if (id.includes("node_modules")) {
            if (id.includes("monaco-editor")) return "vendor-monaco";
            if (id.includes("@xterm")) return "vendor-xterm";
            if (id.includes("marked") || id.includes("dompurify")) return "vendor-markdown";
            if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("scheduler"))
              return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
