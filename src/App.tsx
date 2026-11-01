/**
 * Application shell.
 *
 * - Sticky mobile-first header with brand link, primary nav, and a locale
 *   placeholder switcher (real i18n routes land in the SEO/multilingual phase;
 *   the switcher is visibly present but disabled so it is not mistaken for a
 *   working translation feature).
 * - Footer with the essential links and money-back guarantee copy pulled from
 *   the shared brand config shape (values mirrored here because the browser
 *   bundle must not import server modules).
 * - A very small history-based router that knows only the routes delivered so
 *   far. Unknown routes render a clear "not found" state instead of a blank
 *   page. As later phases add pages, they register in `ROUTES` below.
 */
import { useEffect, useState } from "react";
import { Home } from "./pages/Home";

interface RouteMatch {
  path: string;
}

const ROUTES: Record<string, () => JSX.Element> = {
  "/": Home,
};

/** Match the current pathname to a known page component, else undefined. */
function matchRoute(pathname: string): (() => JSX.Element) | undefined {
  // Normalise trailing slashes.
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  const exact = ROUTES[path];
  if (exact) return exact;
  return undefined;
}

function usePathname(): string {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

function Header(): JSX.Element {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <a href="/" className="flex items-center gap-2" data-testid="brand-link">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-600 text-sm font-black text-white"
          >
            Z
          </span>
          <span className="text-base font-bold text-slate-900">Zipy eSIM</span>
        </a>
        <nav aria-label="Primary" className="hidden items-center gap-5 text-sm text-slate-600 sm:flex">
          <a className="hover:text-slate-900" href="/">Home</a>
          <a className="hover:text-slate-900" href="/trip-planner">Trip planner</a>
          <a className="hover:text-slate-900" href="/my-esims">My eSIMs</a>
        </nav>
        <div className="flex items-center gap-2">
          <label htmlFor="locale-switcher" className="sr-only">
            Language
          </label>
          <select
            id="locale-switcher"
            disabled
            title="Language switcher arrives with multilingual support"
            className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-sm text-slate-500"
            data-testid="locale-switcher"
            defaultValue="en"
          >
            <option value="en">EN</option>
            <option value="zh">中文</option>
            <option value="vi">VI</option>
          </select>
        </div>
      </div>
    </header>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-slate-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-10">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <p className="text-sm font-bold text-slate-900">Zipy eSIM</p>
            <p className="mt-2 text-sm text-slate-600">
              Instant travel data. No roaming surprises.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Full refund if the eSIM is never installed.
            </p>
          </div>
          <nav aria-label="Explore" className="text-sm">
            <p className="font-semibold text-slate-900">Explore</p>
            <ul className="mt-2 space-y-1 text-slate-600">
              <li><a className="hover:text-slate-900" href="/">Popular destinations</a></li>
              <li><a className="hover:text-slate-900" href="/trip-planner">AI trip planner</a></li>
              <li><a className="hover:text-slate-900" href="/my-esims">My eSIMs</a></li>
            </ul>
          </nav>
          <nav aria-label="Tools" className="text-sm">
            <p className="font-semibold text-slate-900">Tools &amp; support</p>
            <ul className="mt-2 space-y-1 text-slate-600">
              <li><a className="hover:text-slate-900" href="/tools/roaming-calculator">Roaming calculator</a></li>
              <li><a className="hover:text-slate-900" href="/tools/phone-checker">Phone compatibility</a></li>
              <li><a className="hover:text-slate-900" href="/support">Support</a></li>
            </ul>
          </nav>
        </div>
        <p className="mt-8 text-xs text-slate-500">
          © {new Date().getFullYear()} Zipy eSIM. Prices shown are indicative until checkout.
        </p>
      </div>
    </footer>
  );
}

export function App(): JSX.Element {
  const pathname = usePathname();
  const page = matchRoute(pathname);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Header />
      <main className="flex-1">
        {page ? (
          // Render the matched page.
          (() => {
            const Page = page;
            return <Page />;
          })()
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-16 text-center" data-testid="not-found">
            <h1 className="text-2xl font-bold text-slate-900">Page not found</h1>
            <p className="mt-2 text-slate-600">
              This page isn’t built yet. Choose a destination from the homepage to browse plans.
            </p>
            <a
              href="/"
              className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
            >
              Back to homepage
            </a>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

/** Re-exported for tests/consumers that only want the route table. */
export const __testRoutes: readonly string[] = Object.keys(ROUTES);
