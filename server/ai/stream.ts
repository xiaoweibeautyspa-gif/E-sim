/**
 * Server-Sent Events writer for the trip planner (and any other streaming
 * route that wants the same contract).
 *
 * The client (`src/pages/TripPlanner.tsx`, `readSse`) reads the response with
 * `fetch` + `ReadableStream`, splits on `\n\n`, and JSON-parses each `data:`
 * line. This module produces exactly that framing:
 *
 *     data: {"type":"meta",...}\n\n
 *     data: {"type":"chunk","section":"ITINERARY","text":"…"}\n\n
 *     data: {"type":"done"}\n\n
 *
 * Responsibilities:
 *  - Set the correct headers (Content-Type: text/event-stream, no-transform,
 *    X-Accel-Buffering: no) so proxies — including Replit's — don't buffer.
 *  - Serialize events safely. `JSON.stringify` of a value containing newlines
 *    is fine; SSE specs want newlines inside `data:` to become multi-line
 *    frames, but for JSON payloads the newlines are escaped, so single-line
 *    frames work. We still strip any raw `\n` a caller might slip in by using
 *    JSON (never a template).
 *  - Detect a closed connection and stop writing instead of throwing into
 *    route handlers; the writer is safe to call after `end()` (no-op).
 *  - Provide `runStreaming` — a small helper that opens the stream, runs a
 *    producer with an `emit` + `end`, and always closes the response (even
 *    when the producer throws). This is the primitive the route's `/plan`
 *    handler should call once it's refactored to use this file; until then
 *    the route has equivalent logic inline.
 *
 * What this module does NOT do:
 *  - Rate limit, validate input, or read the session. Those belong to the
 *    route.
 *  - Retry. If a write fails because the client disconnected, we stop; the
 *    route's `req.on("close")` should already have aborted the model call.
 *  - Heartbeats. SSE doesn't require them for our workloads (plans take
 *    seconds, not minutes), and spurious `: ping\n\n` frames would confuse
 *    strict parsers that only look for `data:`. If a future route needs them,
 *    expose `writeComment()` here rather than duplicating framing.
 */

import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any JSON-serializable event payload. The `type` field is required so the client can discriminate. */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface StreamWriter {
  /** Write one event as a single `data:` frame. No-op after `end()` / disconnect. */
  write(event: StreamEvent): void;
  /** True if the client is still connected and we haven't called `end()`. */
  isOpen(): boolean;
  /** End the response cleanly. Idempotent. */
  end(): void;
}

export interface OpenStreamOptions {
  /** Override the headers (rarely needed; primarily a test hook). */
  headers?: Record<string, string>;
}

/** Thrown by `runStreaming` if a producer tries to write after disconnect — never surfaced to the client. */
export class StreamClosedError extends Error {
  constructor() {
    super("Stream already closed.");
    this.name = "StreamClosedError";
  }
}

// ---------------------------------------------------------------------------
// Low-level writer
// ---------------------------------------------------------------------------

/**
 * Open an SSE stream on `res`. Returns a writer. The caller owns `res` and
 * must call `end()` (directly or via `runStreaming`). We mark the writer
 * closed on `req` "close" so late writes are no-ops rather than EPIPE throws.
 */
export function openStream(
  req: Request,
  res: Response,
  opts: OpenStreamOptions = {},
): StreamWriter {
  let open = true;

  // Headers must be set before any write.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) res.setHeader(k, v);
  }
  // Flush headers immediately so the client can start reading before the
  // first model token arrives.
  res.flushHeaders?.();

  // Detect client disconnect; nothing else here needs to run on `close`,
  // but marking `open = false` prevents "write after end" from throwing.
  req.on("close", () => {
    open = false;
  });

  function write(event: StreamEvent): void {
    if (!open) return;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      // Refuse to write a malformed event — that would break the client's
      // parser. Log-visible failure without leaking internals to the wire.
      throw new Error("Stream event must be an object with a string `type`.");
    }
    // JSON.stringify escapes newlines, so a single `data:` line is correct.
    const payload = JSON.stringify(event);
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      // Client vanished between the close event and this write.
      open = false;
    }
  }

  function end(): void {
    if (!open) return;
    open = false;
    try {
      res.end();
    } catch {
      // Already ended by the client.
    }
  }

  function isOpen(): boolean {
    return open;
  }

  return { write, end, isOpen };
}

// ---------------------------------------------------------------------------
// runStreaming
// ---------------------------------------------------------------------------

/**
 * Open the stream, run `producer`, and always close it.
 *
 * The `producer` receives the writer and an `AbortSignal` that fires when the
 * client disconnects. It should:
 *   - write whatever it needs (the first event is usually `meta`),
 *   - respect the abort signal (stop the model call on `signal.aborted`),
 *   - NOT call `writer.end()` itself — `runStreaming` handles it.
 *
 * If the producer throws, `runStreaming` writes a terminal error event and
 * ends the stream, then rethrows only in the development `throwOnError` case
 * (default off) so production callers can rely on the client always seeing a
 * clean end.
 *
 * If the client aborts, the error event is skipped (there's no one to read
 * it) and the function returns normally.
 */
export async function runStreaming(
  req: Request,
  res: Response,
  producer: (writer: StreamWriter, signal: AbortSignal) => Promise<void>,
  opts: {
    /** Emitted on producer throw. Defaults to a generic ai_failed frame. */
    formatError?: (err: unknown) => StreamEvent;
    /** Header overrides passed through to `openStream`. */
    headers?: Record<string, string>;
  } = {},
): Promise<void> {
  const writer = openStream(req, res, { headers: opts.headers });
  const aborter = new AbortController();
  req.on("close", () => aborter.abort());

  try {
    await producer(writer, aborter.signal);
  } catch (err) {
    if (!aborter.signal.aborted && writer.isOpen()) {
      const event =
        opts.formatError?.(err) ??
        ({
          type: "error",
          code: "ai_failed",
          message:
            err instanceof Error
              ? `The planner hit an error: ${truncate(err.message, 200)}`
              : "The planner hit an error. Try again.",
        } satisfies StreamEvent);
      writer.write(event);
    }
    // Do not rethrow: the route called us synchronously expecting clean end.
    // Callers that need to surface the error (e.g. tests) should inspect the
    // emitted `error` event themselves.
  } finally {
    writer.end();
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

/**
 * Pure serializer used by tests to assert the exact wire format. Not used by
 * production callers, which go through `openStream().write`.
 */
export function serializeEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const __test__ = {
  serializeEvent,
  truncate,
};
