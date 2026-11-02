/**
 * Destination search for the homepage hero.
 *
 * Behaviour:
 * - Live server search via /api/catalog/search (debounced), plus an instant
 *   local match against the popular-destination list so common countries feel
 *   immediate. Local matches also match the friendly country name.
 * - Selecting a destination navigates to its country page. The country page
 *   itself is delivered in a later batch; the link target is correct now.
 * - Full keyboard support (arrow up/down, enter, escape) and a visible empty
 *   and error state. No fake results are ever shown: an error message replaces
 *   the list rather than falling back to stale suggestions.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiClient, countryName, type DestinationSummary } from "../lib/apiClient";

export interface DestinationSearchProps {
  /** Popular destinations already loaded by the page, used for instant matches. */
  popular: DestinationSummary[];
  /** Called instead of navigating, when the host wants to control navigation. */
  onSelect?: (slug: string) => void;
}

interface Suggestion {
  slug: string;
  label: string;
  source: "popular" | "search";
}

function toSuggestion(d: DestinationSummary, source: Suggestion["source"]): Suggestion {
  return { slug: d.slug, label: countryName(d.slug), source };
}

export function DestinationSearch({ popular, onSelect }: DestinationSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();

  // Instant local matches against the already-loaded popular list.
  const localMatches = useMemo<Suggestion[]>(() => {
    if (!trimmed) return popular.slice(0, 6).map((d) => toSuggestion(d, "popular"));
    const needle = trimmed.toLowerCase();
    return popular
      .filter(
        (d) =>
          d.slug.toLowerCase().includes(needle) ||
          countryName(d.slug).toLowerCase().includes(needle),
      )
      .slice(0, 6)
      .map((d) => toSuggestion(d, "popular"));
  }, [popular, trimmed]);

  // Debounced server search for anything not covered locally.
  useEffect(() => {
    if (trimmed.length < 2) {
      setRemote([]);
      setStatus("idle");
      setError(null);
      return;
    }
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("loading");
      setError(null);
      apiClient
        .search(trimmed, controller.signal)
        .then((results) => {
          setRemote(results.map((d) => toSuggestion(d, "search")));
          setStatus("idle");
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setStatus("error");
          setError(err instanceof Error ? err.message : "Search failed. Try again.");
          setRemote([]);
        });
    }, 250);
    return () => {
      clearTimeout(handle);
      abortRef.current?.abort();
    };
  }, [trimmed]);

  // Merge local + remote, de-duplicated by slug, local first.
  const suggestions = useMemo<Suggestion[]>(() => {
    const seen = new Set<string>();
    const merged: Suggestion[] = [];
    for (const s of [...localMatches, ...remote]) {
      if (seen.has(s.slug)) continue;
      seen.add(s.slug);
      merged.push(s);
    }
    return merged.slice(0, 8);
  }, [localMatches, remote]);

  useEffect(() => {
    setActive(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  function select(slug: string) {
    setOpen(false);
    if (onSelect) {
      onSelect(slug);
      return;
    }
    // Default navigation. Uses the History API so a future router can take over.
    window.history.pushState({}, "", `/esim/${slug}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (suggestions.length === 0 ? -1 : (i + 1) % suggestions.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        suggestions.length === 0 ? -1 : (i - 1 + suggestions.length) % suggestions.length,
      );
    } else if (e.key === "Enter") {
      if (open && active >= 0 && suggestions[active]) {
        e.preventDefault();
        select(suggestions[active].slug);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative w-full" data-testid="destination-search">
      <label htmlFor={`${listboxId}-input`} className="sr-only">
        Search destinations
      </label>
      <div className="flex items-center gap-2 rounded-2xl bg-white p-2 shadow-lg shadow-slate-900/5 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
        <span aria-hidden className="pl-2 text-slate-400" data-testid="search-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
        </span>
        <input
          id={`${listboxId}-input`}
          type="search"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && active >= 0 ? `${listboxId}-opt-${active}` : undefined
          }
          placeholder="Where are you travelling?"
          className="min-w-0 flex-1 bg-transparent py-2 text-base text-slate-900 outline-none placeholder:text-slate-400"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so a click on an option registers before the list closes.
            setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={handleKeyDown}
          data-testid="destination-input"
        />
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl bg-white py-1 shadow-xl ring-1 ring-slate-200"
          data-testid="destination-suggestions"
        >
          {status === "loading" && (
            <li className="px-4 py-2 text-sm text-slate-500" data-testid="search-loading">
              Searching…
            </li>
          )}
          {status === "error" && (
            <li className="px-4 py-2 text-sm text-rose-600" data-testid="search-error">
              {error ?? "Search failed."}
            </li>
          )}
          {suggestions.length === 0 && status !== "loading" && status !== "error" && (
            <li className="px-4 py-2 text-sm text-slate-500" data-testid="search-empty">
              {trimmed ? `No destinations match “${trimmed}”.` : "Start typing a country."}
            </li>
          )}
          {suggestions.map((s, i) => (
            <li key={`${s.source}-${s.slug}`} role="option" aria-selected={i === active}>
              <button
                id={`${listboxId}-opt-${i}`}
                type="button"
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                  i === active ? "bg-brand-50 text-brand-900" : "text-slate-800"
                }`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(s.slug)}
                data-testid={`destination-option-${s.slug}`}
              >
                <span className="font-medium">{s.label}</span>
                <span aria-hidden className="text-slate-400">→</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
