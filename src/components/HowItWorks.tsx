/**
 * "How eSIM works" 3-step explainer.
 *
 * Reused on the homepage and country pages. Deliberately copy-only (no data
 * fetching) but the steps are clickable links to real resources so the block
 * is not decorative: step 1 → destination search anchor, step 2 → install
 * guide, step 3 → My eSIMs dashboard. Callers can pass `destinationsHref`
 * (or any of the step hrefs) to adapt the copy to the page they render on.
 */
import { useId } from "react";

export interface HowItWorksStep {
  title: string;
  body: string;
  /** Optional CTA href. When absent, the step renders without a link. */
  href?: string;
  ctaLabel?: string;
}

export interface HowItWorksProps {
  /** `dark` (default) matches the homepage; `light` is for on-white sections. */
  variant?: "dark" | "light";
  /** Optional heading override. Defaults to "How eSIM works". */
  heading?: string;
  /** Optional subline override. */
  intro?: string;
  /**
   * Optional step-level overrides keyed by index. Missing entries fall back to
   * the default install flow so a caller can tweak one step without copying
   * the whole block.
   */
  overrides?: Partial<Record<0 | 1 | 2, Partial<HowItWorksStep>>>;
}

const DEFAULT_STEPS: HowItWorksStep[] = [
  {
    title: "Pick your plan",
    body: "Choose a plan for your destination and pay securely.",
    href: "/#destinations",
    ctaLabel: "Browse destinations",
  },
  {
    title: "Scan the QR",
    body: "Open Settings → Add eSIM and scan the QR code we email you.",
    href: "/install",
    ctaLabel: "Install guide",
  },
  {
    title: "Land connected",
    body: "Switch on the eSIM when you arrive. No roaming fees, no SIM swaps.",
    href: "/my-esims",
    ctaLabel: "My eSIMs",
  },
];

function buildSteps(overrides: HowItWorksProps["overrides"]): HowItWorksStep[] {
  return DEFAULT_STEPS.map((step, i) => {
    const o = overrides?.[i as 0 | 1 | 2];
    return o ? { ...step, ...o } : step;
  });
}

export function HowItWorks({
  variant = "dark",
  heading = "How eSIM works",
  intro = "Three steps from checkout to connected.",
  overrides,
}: HowItWorksProps): JSX.Element {
  const headingId = useId();
  const steps = buildSteps(overrides);
  const isDark = variant === "dark";

  const shellClasses = isDark
    ? "rounded-3xl bg-slate-900 p-6 sm:p-8"
    : "rounded-3xl bg-white p-6 ring-1 ring-slate-200 sm:p-8";
  const headingClasses = isDark ? "text-white" : "text-slate-900";
  const introClasses = isDark ? "text-slate-300" : "text-slate-600";
  const cardClasses = isDark
    ? "bg-white/5 ring-1 ring-white/10"
    : "bg-slate-50 ring-1 ring-slate-200";
  const titleClasses = isDark ? "text-white" : "text-slate-900";
  const bodyClasses = isDark ? "text-slate-300" : "text-slate-600";
  const ctaClasses = isDark
    ? "text-brand-300 hover:text-brand-200"
    : "text-brand-700 hover:text-brand-800";

  return (
    <section aria-labelledby={headingId} className={shellClasses} data-testid="how-it-works">
      <h2 id={headingId} className={`text-xl font-bold sm:text-2xl ${headingClasses}`}>
        {heading}
      </h2>
      <p className={`mt-1 text-sm ${introClasses}`}>{intro}</p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className={`rounded-2xl p-4 ${cardClasses}`}>
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-sm font-bold text-white"
            >
              {i + 1}
            </span>
            <p className={`mt-3 font-semibold ${titleClasses}`}>{step.title}</p>
            <p className={`mt-1 text-sm ${bodyClasses}`}>{step.body}</p>
            {step.href && step.ctaLabel && (
              <a
                href={step.href}
                className={`mt-3 inline-flex items-center gap-1 text-sm font-medium ${ctaClasses}`}
                data-testid={`how-it-works-cta-${i}`}
              >
                {step.ctaLabel}
                <span aria-hidden>→</span>
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
