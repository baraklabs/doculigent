import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main/index.ts"),
          // Forked as its own UtilityProcess by whisperWorkerClient.ts (out/main/index.js
          // loads it at runtime by path) — must build to a standalone entry, not get
          // bundled into index.js, since utilityProcess.fork() needs a real module path.
          transcriptionWorker: resolve(__dirname, "electron/main/transcription/transcriptionWorker.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload/index.ts") },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "shared"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    envDir: resolve(__dirname, "env"),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/index.html") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
  },
});
