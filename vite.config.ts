import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vite configuration for the storefront client.
 *
 * Notes:
 * - `root` is the project root; HTML lives in `index.html` (added by the
 *   storefront phase). Until that file exists, `vite` dev serves an empty
 *   placeholder and `vite build` fails with "Could not resolve entry module"
 *   — which is honest: the storefront is not part of this foundation phase.
 * - Dev server binds 0.0.0.0 so Replit's preview proxy is reachable.
 * - In dev, `/api` is proxied to the Express server so the SPA never has to
 *   hardcode a base URL. In production, Express serves the built assets.
 * - Build outputs to `dist/client`; the server build writes to `dist/server`
 *   (see tsconfig.server.json in a later batch). `npm run start` runs the
 *   compiled server which serves both, honouring process.env.PORT.
 * - Chunks split vendor code so the storefront can ship a small initial
 *   bundle for Core Web Vitals.
 */
export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://0.0.0.0:3000",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
  optimizeDeps: {
    // Keep SSR-unsafe packages out of the client prebundle.
    exclude: ["pg", "drizzle-orm"],
  },
});
