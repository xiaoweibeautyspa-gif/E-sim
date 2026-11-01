/**
 * Site-wide support chat widget.
 *
 * Contract with the backend (server/routes/ai.ts):
 *   POST /api/ai/support-chat  { messages: ChatMessage[] }
 *     → 200 { ok: true, data: SupportChatResponse }
 *     → 4xx/5xx { ok: false, error, message }   (429 rate limit → retry-after)
 *
 * Behaviour:
 *  - Floating action button bottom-right; opens a compact panel.
 *  - Keeps a local conversation (never persisted to server beyond the request).
 *  - If the session carries a signed-in user (backend infers this from cookies),
 *    the assistant's replies already see the user's eSIMs — we don't need to
 *    pass anything extra. The `esimContext` in the response lets us show a
 *    small "Looking at your eSIMs" header so the user knows what the AI sees.
 *  - Escalation: when the response includes `escalation`, render WhatsApp and
 *    email buttons. We never fabricate these — the server supplies them from
 *    brand config, and we ALSO fall back to brand config values so the widget
 *    has stable support contacts even if the model didn't trigger escalation.
 *  - If the AI backend is unavailable (503 / no key), the panel degrades to a
 *    static escalation card. No fake assistant messages.
 *
 * Accessibility:
 *  - Panel is a dialog (role="dialog", aria-modal), labelled by its title.
 *  - Escape closes; focus is trapped loosely (we focus the input on open).
 *  - The FAB is a real button with an aria-label so screen readers announce it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { brand } from "../../server/brand.config";

// ---------------------------------------------------------------------------
// Types — mirrored structurally from server/routes/ai.ts so this file doesn't
// import server code at runtime (Vite would strip types, but a direct import
// of a .ts file from the client is not safe). Keep them in sync.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface SupportChatResponse {
  reply: string;
  escalation: {
    whatsappNumber: string;
    whatsappUrl: string;
    emailAddress: string;
    emailUrl: string;
  } | null;
  esimContext: Array<{
    id: number;
    country: string | null;
    planName: string | null;
    status: string;
    daysLeft: number | null;
    usedBytes: number | null;
    totalBytes: number | null;
    topUpEligible: boolean;
  }>;
}

interface ApiErr {
  ok: false;
  error: string;
  message: string;
  retryAfterSeconds?: number;
}
interface ApiOk<T> {
  ok: true;
  data: T;
}

class SupportChatError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "SupportChatError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function sendChat(messages: ChatMessage[], signal: AbortSignal): Promise<SupportChatResponse> {
  const res = await fetch("/api/ai/support-chat", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as ApiOk<SupportChatResponse> | ApiErr | {};
  if (!res.ok || !("ok" in json) || json.ok === false) {
    const err = json as ApiErr;
    const code = err?.error ?? "request_failed";
    const message = err?.message ?? `Request failed (HTTP ${res.status}).`;
    throw new SupportChatError(code, message, err?.retryAfterSeconds ?? null);
  }
  return (json as ApiOk<SupportChatResponse>).data;
}

// ---------------------------------------------------------------------------
// Static escalation URLs — a stable fallback from brand config
// ---------------------------------------------------------------------------

const STATIC_ESCALATION = {
  whatsappNumber: brand.supportWhatsApp,
  whatsappUrl: `https://wa.me/${brand.supportWhatsApp.replace(/[^0-9]/g, "")}`,
  emailAddress: brand.supportEmail,
  emailUrl: `mailto:${brand.supportEmail}`,
};

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export interface SupportChatProps {
  /** Called when the user opens the widget (for analytics/autofocus elsewhere). */
  onOpen?: () => void;
}

const WELCOME: ChatMessage = {
  role: "assistant",
  content:
    "Hi! I'm here to help with installing your eSIM, activation, or troubleshooting. What's going on?",
};

export function SupportChat({ onOpen }: SupportChatProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; retryAfterSeconds: number | null } | null>(
    null,
  );
  const [esimContext, setEsimContext] = useState<SupportChatResponse["esimContext"]>([]);
  const [serverEscalation, setServerEscalation] = useState<SupportChatResponse["escalation"]>(null);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Focus input + notify when opened.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      onOpen?.();
    }
  }, [open, onOpen]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, error]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setSending(true);

    const controller = new AbortController();
    try {
      const resp = await sendChat(nextMessages, controller.signal);
      setMessages([...nextMessages, { role: "assistant", content: resp.reply }]);
      if (resp.esimContext.length > 0) setEsimContext(resp.esimContext);
      if (resp.escalation) setServerEscalation(resp.escalation);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof SupportChatError) {
        setError({
          code: err.code,
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      } else {
        setError({
          code: "request_failed",
          message: "We couldn't reach support chat. Try WhatsApp or email below.",
          retryAfterSeconds: null,
        });
      }
      // Remove the optimistic user message so the row doesn't look "sent"
      // when we can't confirm the server accepted it.
      setMessages(messages);
    } finally {
      setSending(false);
    }
  }, [input, messages, sending]);

  // Fallback always available: chat button exits to WhatsApp/email if AI is down.
  const esc = serverEscalation ?? STATIC_ESCALATION;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open support chat"
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-600/30 transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        data-testid="support-chat-fab"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 12a8 8 0 1 1-3.1-6.3L21 4l-1.5 3.5A8 8 0 0 1 21 12z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-3xl bg-white shadow-2xl ring-1 ring-slate-200 sm:inset-auto sm:bottom-5 sm:right-5 sm:max-h-[560px] sm:w-[380px] sm:rounded-2xl"
      data-testid="support-chat-panel"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-brand-700 font-bold">
            Z
          </span>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-slate-900">
              Support chat
            </h2>
            <p className="text-[11px] text-slate-500">
              {esimContext.length > 0
                ? `Looking at your ${esimContext.length} eSIM${esimContext.length === 1 ? "" : "s"}`
                : "Ask anything about your eSIM"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close support chat"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="support-chat-messages">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${
              m.role === "user"
                ? "ml-auto bg-brand-600 text-white"
                : "bg-slate-100 text-slate-800"
            }`}
            data-testid={`chat-message-${m.role}`}
          >
            {m.content}
          </div>
        ))}

        {sending && (
          <div className="max-w-[85%] rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-500" aria-busy data-testid="chat-typing">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:240ms]" />
            </span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200"
            data-testid="chat-error"
            data-error-code={error.code}
          >
            <p>{error.message}</p>
            {error.retryAfterSeconds && (
              <p className="mt-1 text-[11px] text-rose-700/80">
                Try again in {error.retryAfterSeconds}s.
              </p>
            )}
          </div>
        )}

        {esimContext.length > 0 && (
          <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
            <summary className="cursor-pointer font-medium text-slate-700">
              What the assistant can see
            </summary>
            <ul className="mt-2 space-y-1">
              {esimContext.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2">
                  <span>{e.country ?? "eSIM"}</span>
                  <span className="text-slate-400">{e.status}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <footer className="border-t border-slate-200 px-3 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-end gap-2"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Type your question…"
            className="max-h-24 w-full resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            data-testid="support-chat-input"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            data-testid="support-chat-send"
          >
            Send
          </button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>Still stuck?</span>
          <a
            href={esc!.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-emerald-700 hover:text-emerald-800"
            data-testid="support-chat-whatsapp"
          >
            WhatsApp us
          </a>
          <a
            href={esc!.emailUrl}
            className="font-medium text-brand-700 hover:text-brand-800"
            data-testid="support-chat-email"
          >
            Email support
          </a>
        </div>
      </footer>
    </div>
  );
}
