/**
 * Homepage.
 *
 * Sections (all read from the catalog API, never the supplier):
 * - Hero with destination search.
 * - Popular destinations (server-ranked availability).
 * - Regional plans, global plans, daily unlimited plans.
 * - "How eSIM works" 3-step explainer.
 *
 * State handling is explicit per section: independent loading, empty and error
 * states so one failing endpoint never blanks the whole page. No placeholder
 * plans are invented — an empty section says so plainly.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DestinationSearch } from "../components/DestinationSearch";
import {
  apiClient,
  countryName,
  formatMoney,
  type CatalogPlan,
  type DestinationSummary,
  type DisplayCurrency,
} from "../lib/apiClient";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>): {
  state: LoadState<T>;
  reload: () => void;
} {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loader(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Something went wrong.",
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}

function PlanGridSkeleton({ count = 3 }: { count?: number }): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-2xl bg-slate-100 ring-1 ring-slate-200"
        />
      ))}
    </div>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-700"
      >
        Try again
      </button>
    </div>
  );
}

interface PlanCardProps {
  plan: CatalogPlan;
  currency: DisplayCurrency;
}

function MiniPlanCard({ plan, currency }: PlanCardProps): JSX.Element {
  const network = plan.operators[0];
  const dataLabel = plan.isDailyPlan
    ? "Unlimited per day"
    : plan.dataGb != null
      ? `${plan.dataGb} GB`
      : "Data included";
  return (
    <a
      href={`/esim/${plan.countrySlug ?? (plan.countries[0] ?? "").toLowerCase()}`}
      className="group flex flex-col rounded-2xl bg-white p-4 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-lg hover:ring-brand-300"
      data-testid={`plan-card-${plan.code}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">{plan.name}</p>
          {plan.region && (
            <p className="mt-0.5 text-xs uppercase tracking-wide text-brand-600">
              {plan.region}
            </p>
          )}
        </div>
        <p className="whitespace-nowrap text-right text-base font-bold text-slate-900">
          {formatMoney(plan.retailUsd, currency)}
        </p>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <div>
          <dt className="inline text-slate-400">Data: </dt>
          <dd className="inline font-medium text-slate-700">{dataLabel}</dd>
        </div>
        {plan.durationDays != null && (
          <div>
            <dt className="inline text-slate-400">Valid: </dt>
            <dd className="inline font-medium text-slate-700">
              {plan.durationDays} {plan.durationDays === 1 ? "day" : "days"}
            </dd>
          </div>
        )}
      </dl>
      {network && (
        <p className="mt-3 text-xs text-slate-500">
          Runs on <span className="font-medium text-slate-700">{network}</span>
        </p>
      )}
      <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700">
        View plans <span aria-hidden className="transition group-hover:translate-x-0.5">→</span>
      </span>
    </a>
  );
}

function PopularDestinations({
  state,
  currency,
  onRetry,
}: {
  state: LoadState<DestinationSummary[]>;
  currency: DisplayCurrency;
  onRetry: () => void;
}): JSX.Element {
  return (
    <section aria-labelledby="popular-heading">
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 id="popular-heading" className="text-xl font-bold text-slate-900 sm:text-2xl">
          Popular destinations
        </h2>
      </div>
      {state.status === "loading" && <PlanGridSkeleton count={6} />}
      {state.status === "error" && <SectionError message={state.message} onRetry={onRetry} />}
      {state.status === "ready" && state.data.length === 0 && (
        <p className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">
          No destinations are available yet. The catalog is still syncing.
        </p>
      )}
      {state.status === "ready" && state.data.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {state.data.map((d) => (
            <li key={d.slug}>
              <a
                href={`/esim/${d.slug}`}
                className="flex h-full flex-col justify-between rounded-2xl bg-gradient-to-br from-brand-50 to-white p-4 ring-1 ring-brand-100 transition hover:-translate-y-0.5 hover:shadow-lg"
                data-testid={`destination-${d.slug}`}
              >
                <span className="text-base font-semibold text-slate-900">
                  {countryName(d.slug)}
                </span>
                <span className="mt-2 text-xs text-slate-600">
                  {d.plans} {d.plans === 1 ? "plan" : "plans"} · from{" "}
                  <span className="font-semibold text-brand-700">
                    {formatMoney(d.minPriceUsd, currency)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlanSection({
  id,
  title,
  subtitle,
  state,
  currency,
  onRetry,
}: {
  id: string;
  title: string;
  subtitle: string;
  state: LoadState<CatalogPlan[]>;
  currency: DisplayCurrency;
  onRetry: () => void;
}): JSX.Element {
  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="text-xl font-bold text-slate-900 sm:text-2xl">
        {title}
      </h2>
      <p className="mb-4 mt-1 text-sm text-slate-600">{subtitle}</p>
      {state.status === "loading" && <PlanGridSkeleton />}
      {state.status === "error" && <SectionError message={state.message} onRetry={onRetry} />}
      {state.status === "ready" && state.data.length === 0 && (
        <p className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">
          No plans in this category yet.
        </p>
      )}
      {state.status === "ready" && state.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {state.data.slice(0, 6).map((p) => (
            <MiniPlanCard key={p.code} plan={p} currency={currency} />
          ))}
        </div>
      )}
    </section>
  );
}

function HowItWorks(): JSX.Element {
  const steps = [
    {
      title: "Pick your plan",
      body: "Choose a plan for your destination and pay securely.",
    },
    {
      title: "Scan the QR",
      body: "Open Settings → Add eSIM and scan the QR code we email you.",
    },
    {
      title: "Land connected",
      body: "Switch on the eSIM when you arrive. No roaming fees, no SIM swaps.",
    },
  ];
  return (
    <section aria-labelledby="how-heading" className="rounded-3xl bg-slate-900 p-6 sm:p-8">
      <h2 id="how-heading" className="text-xl font-bold text-white sm:text-2xl">
        How eSIM works
      </h2>
      <p className="mt-1 text-sm text-slate-300">Three steps from checkout to connected.</p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-sm font-bold text-white">
              {i + 1}
            </span>
            <p className="mt-3 font-semibold text-white">{s.title}</p>
            <p className="mt-1 text-sm text-slate-300">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Home(): JSX.Element {
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");

  const destinations = useAsync((signal) => apiClient.listDestinations({ limit: 8, signal }));
  const regional = useAsync((signal) => apiClient.listRegionalPlans(signal));
  const global = useAsync((signal) => apiClient.listGlobalPlans(signal));
  const daily = useAsync((signal) => apiClient.listDailyPlans(signal));

  // Popular list passed to the search for instant local matches.
  const popular = useMemo<DestinationSummary[]>(
    () => (destinations.state.status === "ready" ? destinations.state.data : []),
    [destinations.state],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-brand-500 to-brand-700 px-5 py-10 text-white sm:px-10 sm:py-14">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-extrabold leading-tight sm:text-4xl">
            Instant travel data, without the roaming bill
          </h1>
          <p className="mt-3 text-base text-brand-50/90">
            Buy an eSIM before you fly, scan a QR on landing, and stay online in over 100
            destinations.
          </p>
          <div className="mt-6 max-w-lg">
            <DestinationSearch popular={popular} />
          </div>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <label htmlFor="hero-currency" className="text-brand-50/80">
              Show prices in
            </label>
            <select
              id="hero-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as DisplayCurrency)}
              className="rounded-lg border-0 bg-white/15 px-2 py-1 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-white"
              data-testid="currency-select"
            >
              <option className="text-slate-900" value="USD">USD</option>
              <option className="text-slate-900" value="SGD">SGD</option>
              <option className="text-slate-900" value="VND">VND</option>
              <option className="text-slate-900" value="CNY">CNY</option>
            </select>
            <span className="text-xs text-brand-50/60">Indicative — settled at checkout</span>
          </div>
        </div>
      </section>

      <div className="mt-10 space-y-12">
        <PopularDestinations
          state={destinations.state}
          currency={currency}
          onRetry={destinations.reload}
        />
        <PlanSection
          id="regional"
          title="Regional plans"
          subtitle="One eSIM across a whole region — great for multi-country trips."
          state={regional.state}
          currency={currency}
          onRetry={regional.reload}
        />
        <PlanSection
          id="global"
          title="Global plans"
          subtitle="Coverage across many countries with a single eSIM."
          state={global.state}
          currency={currency}
          onRetry={global.reload}
        />
        <PlanSection
          id="daily"
          title="Daily unlimited plans"
          subtitle="Unlimited data billed per day — ideal for short city breaks."
          state={daily.state}
          currency={currency}
          onRetry={daily.reload}
        />
        <HowItWorks />
      </div>
    </div>
  );
}
