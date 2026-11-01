import http from "node:http";
import { createApp } from "./app";
import { loadEnv } from "./config/env";

/**
 * Runtime entrypoint.
 *
 * Replit contract:
 * - Read the port from process.env.PORT (env loader falls back to 3000 only
 *   for local dev).
 * - Bind to 0.0.0.0 so the platform's edge can reach the process.
 * - Gracefully shut down on SIGTERM/SIGINT.
 * - Do NOT start scheduled jobs here yet; those are added by their own phases
 *   so this process stays dumb-by-default.
 */
function main(): void {
  const env = loadEnv();
  const app = createApp();
  const server = http.createServer(app);

  for (const w of env.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[env warning] ${w}`);
  }

  server.listen(env.port, env.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[server] listening on http://${env.host}:${env.port} (env=${env.raw.NODE_ENV})`,
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    // Force exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
