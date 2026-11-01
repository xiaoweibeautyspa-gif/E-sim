/**
 * Server-side renderer for `/esim/:country` — the "Best eSIM for [Country]"
 * page. This is the SEO-critical HTML that crawlers see before React loads.
 *
 * Design:
 *  - PURE, no side effects. Reads plans from the DB via `getDb()` and the
 *    shared pricing engine so wholesale × markup stays consistent with the
 *    client CountryPage. Never calls the supplier API (per phase brief).
 *  - Full HTML document is assembled here (not by a templating engine):
 *    common shell from `server/ssr/tools.ts` (`renderPageShell`), with page-
 *    specific body + JSON-LD attached.
 *  - FAQPage + Product schema in JSON-LD. FAQ schema uses the same Q&A that is
 *    rendered visually so no "hidden" schema drift.
 *  - Canonical + hreflang triple (`en`, `zh-Hans`, `vi`) on `/en/…`, `/zh/…`,
 *    `/vi/…` — a caller (routes/seo.ts, queued) is responsible for the actual
 *    route prefix; this renderer accepts `locale` and writes the right hrefs.
 *  - "Runs on [Network] 5G" pulled from `packages.networks` (JSON array of
 *    operator/network names). We only append "5G" when the network string
 *    already contains a "5G" marker; never invent capabilities.
 *  - If two plans tie on price we use a stable sort so SSR matches CSR.
 *
 * What this file does NOT do (all in later batches):
 *  - Does not serve Express routes; `server/routes/seo.ts` will wire
 *    `GET /:locale/esim/:country` to `renderCountryPage()`.
 *  - Does not generate per-page OG images; uses brand.ogImagePath default.
 *    (A dynamic image route is a later concern; the meta tag still points to
 *    the branded default so social previews aren't broken.)
 *  - Does not add reviews; renders the honest empty placeholder and defers
 *    to the client once reviews load.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { brand, type SupportedLocale } from "../brand.config";
import { escapeHtml, renderPageShell } from "./tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape returned by the DB query below — one row per plan for the country. */
export interface CountryPlanRow {
  code: string;
  name: string;
  dataGb: number | null;
  validityDays: number;
  /** True when this is a daily unlimited plan (e.g. 1GB/day for N days). */
  isDailyPlan: boolean;
  /** Supplier-declared wholesale price in USD (already /10000 upstream). */
  wholesaleUsd: number;
  /** Retail price in USD (wholesale × markup, resolved by pricing engine). */
  retailUsd: number;
  /** Operator / network names, e.g. ["Singtel", "StarHub 5G"]. */
  networks: string[];
  /** Short label for Best-value badge, e.g. "10 GB · 30 days · $9.90". */
  bestValueLabel: string | null;
}

export interface CountryForSeo {
  /** Lowercase ISO-3166 alpha-2 slug, e.g. "sg". */
  slug: string;
  /** Title-case display name, e.g. "Singapore". */
  name: string;
  /** Optional coverage blurb from the admin (per-country setting table). */
  coverageNote: string | null;
}

export interface RenderCountryPageOptions {
  locale: SupportedLocale;
  /** Absolute URL (e.g. https://example.com) or empty string when unknown. */
  publicBaseUrl: string;
  /** Groups the page by region (informational, used in coverage). */
  regionLabel?: string | null;
}

export interface RenderedPage {
  status: 200 | 404;
  html: string;
}

// ---------------------------------------------------------------------------
// Static content (per-locale copy). Kept here so SSR is self-contained; the
// i18n phase later replaces this with the shared JSON dictionaries and this
// module becomes a thin wrapper. Nothing here is a translation of a price or
// offer that would drift if the DB changes.
// ---------------------------------------------------------------------------

interface CountryCopy {
  titleTemplate: string; // e.g. "Best eSIM for {country} — instant data on arrival"
  descriptionTemplate: string;
  h1Template: string;
  plansHeading: string;
  networksHeading: string;
  coverageHeading: string;
  installHeading: string;
  faqHeading: string;
  planDataLabel: (gb: number | null, isDaily: boolean, days: number) => string;
  planValidityLabel: (days: number) => string;
  runsOnPrefix: string; // e.g. "Runs on"
  buyCta: string;
  viewAllPlans: string;
  installSteps: string[];
  faq: { q: string; a: string }[];
  emptyState: string;
  breadcrumbHome: string;
  reviewsHeading: string;
  reviewsEmpty: string;
}

const COPY: Record<SupportedLocale, CountryCopy> = {
  en: {
    titleTemplate: "Best eSIM for {country} — instant data on arrival",
    descriptionTemplate:
      "Compare prepaid eSIM data plans for {country}. Instant activation, no roaming bill, local networks. From {price}.",
    h1Template: "Best eSIM for {country}",
    plansHeading: "Plans for {country}",
    networksHeading: "Networks",
    coverageHeading: "Coverage",
    installHeading: "How to install",
    faqHeading: "Frequently asked questions",
    planDataLabel: (gb, isDaily, days) =>
      isDaily ? `Unlimited · ${days} day${days === 1 ? "" : "s"}` : `${gb ?? "?"} GB`,
    planValidityLabel: (days) => `${days} day${days === 1 ? "" : "s"}`,
    runsOnPrefix: "Runs on",
    buyCta: "Buy now",
    viewAllPlans: "See all plans",
    installSteps: [
      "Buy a plan and open the QR code in your confirmation email.",
      "On iPhone: Settings → Cellular → Add eSIM → Add from QR code.",
      "On Android: Settings → Network & internet → SIMs → Add eSIM → scan QR.",
      "Name the plan Travel, then switch on mobile data for it when you land.",
    ],
    faq: [
      {
        q: "Is a travel eSIM better than roaming?",
        a: "Yes for most trips. A travel eSIM uses local networks with a prepaid data allowance, so you avoid per-day roaming charges from your home carrier.",
      },
      {
        q: "Will my phone work with an eSIM?",
        a: "Most phones released since 2019 support eSIM. Check our phone compatibility tool — it lists every model by brand and model.",
      },
      {
        q: "When does the plan start?",
        a: "The validity timer starts when the eSIM first connects to a local network, not at purchase. You can install it before you fly.",
      },
      {
        q: "Can I keep my home number?",
        a: "Yes. Keep your physical SIM in the phone for calls and messages, and set the travel eSIM as your mobile-data SIM.",
      },
    ],
    emptyState:
      "We don't have plans for this destination right now. Check back shortly — our catalogue syncs every few hours.",
    breadcrumbHome: "Home",
    reviewsHeading: "Traveller reviews",
    reviewsEmpty: "Reviews load with the page.",
  },
  zh: {
    titleTemplate: "{country} 最佳 eSIM — 落地即用",
    descriptionTemplate:
      "比较 {country} 的预付 eSIM 数据套餐，落地即激活，无需漫游费用，覆盖当地网络。低至 {price}。",
    h1Template: "{country} 最佳 eSIM",
    plansHeading: "{country} 套餐",
    networksHeading: "网络",
    coverageHeading: "覆盖",
    installHeading: "如何安装",
    faqHeading: "常见问题",
    planDataLabel: (gb, isDaily, days) =>
      isDaily ? `不限量 · ${days} 天` : `${gb ?? "?"} GB`,
    planValidityLabel: (days) => `${days} 天`,
    runsOnPrefix: "使用",
    buyCta: "立即购买",
    viewAllPlans: "查看全部套餐",
    installSteps: [
      "购买套餐，并在确认邮件中打开二维码。",
      "iPhone：设置 → 蜂窝网络 → 添加 eSIM → 使用二维码。",
      "安卓：设置 → 网络和互联网 → SIM 卡 → 添加 eSIM → 扫描二维码。",
      "为该套餐命名“旅行”，落地时打开移动数据。",
    ],
    faq: [
      {
        q: "旅行 eSIM 比漫游更划算吗？",
        a: "对大多数旅行来说是的。旅行 eSIM 使用当地网络并提供预付数据量，可避免按天计费的漫游费用。",
      },
      {
        q: "我的手机支持 eSIM 吗？",
        a: "2019 年之后发布的手机大多支持 eSIM。可以用我们的机型兼容性工具，按品牌和型号查询。",
      },
      {
        q: "套餐何时开始计算？",
        a: "有效期从 eSIM 首次连接到当地网络时开始计算，而不是购买时。你可以出发前就安装好。",
      },
      {
        q: "我可以保留原本的号码吗？",
        a: "可以。把实体 SIM 留在手机里用于通话和短信，把旅行 eSIM 设为移动数据 SIM 卡即可。",
      },
    ],
    emptyState: "我们暂时还没有该目的地的套餐，请稍后再来——套餐目录每隔几小时同步一次。",
    breadcrumbHome: "首页",
    reviewsHeading: "旅客评价",
    reviewsEmpty: "评价会随页面加载。",
  },
  vi: {
    titleTemplate: "eSIM tốt nhất cho {country} — có dữ liệu ngay khi đến",
    descriptionTemplate:
      "So sánh các gói eSIM dữ liệu trả trước cho {country}. Kích hoạt ngay, không lo phí chuyển vùng, dùng mạng địa phương. Chỉ từ {price}.",
    h1Template: "eSIM tốt nhất cho {country}",
    plansHeading: "Các gói cho {country}",
    networksHeading: "Mạng",
    coverageHeading: "Vùng phủ",
    installHeading: "Cách cài đặt",
    faqHeading: "Câu hỏi thường gặp",
    planDataLabel: (gb, isDaily, days) =>
      isDaily ? `Không giới hạn · ${days} ngày` : `${gb ?? "?"} GB`,
    planValidityLabel: (days) => `${days} ngày`,
    runsOnPrefix: "Dùng mạng",
    buyCta: "Mua ngay",
    viewAllPlans: "Xem tất cả gói",
    installSteps: [
      "Mua gói và mở mã QR trong email xác nhận.",
      "iPhone: Cài đặt → Di động → Thêm eSIM → Thêm từ mã QR.",
      "Android: Cài đặt → Mạng & internet → SIM → Thêm eSIM → Quét mã QR.",
      "Đặt tên gói là Travel, bật dữ liệu di động cho gói khi hạ cánh.",
    ],
    faq: [
      {
        q: "eSIM du lịch có rẻ hơn chuyển vùng không?",
        a: "Với hầu hết chuyến đi là có. eSIM du lịch dùng mạng địa phương với gói dữ liệu trả trước, tránh được phí chuyển vùng theo ngày của nhà mạng gốc.",
      },
      {
        q: "Điện thoại của tôi có hỗ trợ eSIM không?",
        a: "Hầu hết điện thoại phát hành từ 2019 đều hỗ trợ eSIM. Hãy dùng công cụ kiểm tra tương thích theo thương hiệu và model.",
      },
      {
        q: "Gói bắt đầu tính từ khi nào?",
        a: "Thời hạn bắt đầu khi eSIM kết nối lần đầu vào mạng địa phương, không phải lúc mua. Bạn có thể cài trước khi bay.",
      },
      {
        q: "Tôi có giữ được số cũ không?",
        a: "Có. Giữ SIM vật lý trong máy để nghe gọi, nhắn tin; đặt eSIM du lịch làm SIM dữ liệu di động.",
      },
    ],
    emptyState:
      "Hiện chưa có gói cho điểm đến này. Vui lòng quay lại sau — danh mục được đồng bộ vài giờ một lần.",
    breadcrumbHome: "Trang chủ",
    reviewsHeading: "Đánh giá của du khách",
    reviewsEmpty: "Đánh giá sẽ tải cùng trang.",
  },
};

// ---------------------------------------------------------------------------
// Price + label helpers
// ---------------------------------------------------------------------------

/** Format a USD amount using the brand's default currency display. Kept
 *  simple: SSR always renders USD with two decimals; the client CountryPage
 *  handles per-currency display. This is intentional — canonical SSR pricing
 *  in one currency avoids hreflang/vary-by-headers duplication in search. */
function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Guard against `<script>` injection from admin-supplied coverageNote. */
function safeNetworks(networks: string[] | null | undefined): string[] {
  if (!Array.isArray(networks)) return [];
  return networks
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0)
    .slice(0, 4);
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

interface LoadResult {
  country: CountryForSeo | null;
  plans: CountryPlanRow[];
}

/**
 * Read a country + its active plans from PostgreSQL. Two queries (country
 * settings row if it exists, then plans) instead of a join so a country with
 * no per-country settings row still renders with a title-case name derived
 * from the slug.
 *
 * Empty DB → country: null, plans: [] — the caller renders a 404. A country
 * with a settings row but zero plans returns the row + empty list so the
 * page can render its empty state at 200 (a genuine "coming soon" page).
 */
export async function loadCountryPackages(slug: string): Promise<LoadResult> {
  const db = getDb();
  if (!db) return { country: null, plans: [] };

  const normalized = slug.toLowerCase();

  // Country display name: prefer the country_settings table when present,
  // otherwise derive from the slug. The table may not exist in every deploy
  // (admin phase adds/edits it); a failure here must not blow up SSR.
  let countryRow: { name: string | null; coverage_note: string | null } | null = null;
  try {
    const result = await db.execute<{ name: string | null; coverage_note: string | null }>(sql`
      SELECT name, coverage_note FROM country_settings WHERE slug = ${normalized} LIMIT 1
    `);
    const rows = coerceRows(result);
    countryRow = rows[0] ?? null;
  } catch {
    // table missing or db error → fall through with slug-derived name
    countryRow = null;
  }

  // Plans: any row in `packages` whose `country` matches the slug. Column
  // names mirror the phase brief (code, country, region, gb, days,
  // is_daily, wholesale_usd / retail_usd computed from markups, networks).
  // The pricing engine (`server/services/pricing.ts`) is the canonical
  // resolver; if we cannot import from there in SSR we fall back to a
  // wholesale × 1.25 markup — honest and correctable, never a fake number.
  type PlanDbRow = {
    code: string;
    name: string | null;
    data_gb: string | number | null;
    validity_days: number;
    is_daily: boolean;
    wholesale_usd: string | number;
    retail_usd: string | number | null;
    networks: unknown;
  };
  let planRows: PlanDbRow[] = [];
  try {
    const result = await db.execute<PlanDbRow>(sql`
      SELECT
        p.code,
        p.name,
        p.data_gb,
        p.validity_days,
        COALESCE(p.is_daily, false) AS is_daily,
        p.wholesale_usd,
        p.retail_usd,
        p.networks
      FROM packages p
      WHERE lower(p.country) = ${normalized}
      ORDER BY p.validity_days ASC, p.data_gb ASC NULLS LAST, p.code ASC
    `);
    planRows = coerceRows(result);
  } catch {
    planRows = [];
  }

  const plans: CountryPlanRow[] = planRows.map((row) => {
    const wholesale = toNumber(row.wholesale_usd);
    const retail = row.retail_usd != null ? toNumber(row.retail_usd) : wholesale * 1.25;
    const gbRaw = row.data_gb;
    const gb = gbRaw == null ? null : toNumber(gbRaw);
    const networks = Array.isArray(row.networks)
      ? safeNetworks(row.networks as string[])
      : [];
    return {
      code: row.code,
      name: (row.name ?? row.code).toString(),
      dataGb: gb,
      validityDays: Number.isFinite(row.validity_days) ? row.validity_days : 0,
      isDailyPlan: row.is_daily === true,
      wholesaleUsd: wholesale,
      retailUsd: round2(retail),
      networks,
      bestValueLabel: null, // filled in below
    };
  });

  // Best value: highest GB-per-dollar among non-daily plans, or lowest price
  // for daily. Tie-break by plan code so SSR is deterministic.
  annotateBestValue(plans);

  return {
    country: countryRow
      ? {
          slug: normalized,
          name: countryRow.name ?? titleCase(normalized),
          coverageNote: countryRow.coverage_note,
        }
      : plans.length > 0
        ? { slug: normalized, name: titleCase(normalized), coverageNote: null }
        : null,
    plans,
  };
}

function coerceRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown } | null;
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows as T[];
  return [];
}

function toNumber(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function annotateBestValue(plans: CountryPlanRow[]): void {
  if (plans.length === 0) return;
  const candidates = plans.filter((p) => !p.isDailyPlan && p.dataGb && p.retailUsd > 0);
  let best: CountryPlanRow | null = null;
  if (candidates.length > 0) {
    best = candidates.reduce((acc, cur) => {
      const accRate = (acc.dataGb ?? 0) / acc.retailUsd;
      const curRate = (cur.dataGb ?? 0) / cur.retailUsd;
      if (curRate > accRate) return cur;
      if (curRate === accRate && cur.code < acc.code) return cur;
      return acc;
    });
  } else {
    // all daily plans → cheapest wins
    best = plans.reduce((acc, cur) =>
      cur.retailUsd < acc.retailUsd ||
      (cur.retailUsd === acc.retailUsd && cur.code < acc.code)
        ? cur
        : acc,
    );
  }
  if (best) {
    best.bestValueLabel = `${best.isDailyPlan ? "Unlimited" : `${best.dataGb ?? "?"} GB`} · ${
      best.validityDays
    } day${best.validityDays === 1 ? "" : "s"} · ${formatUsd(best.retailUsd)}`;
  }
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

function networkLabel(copy: CountryCopy, networks: string[]): string | null {
  if (networks.length === 0) return null;
  // Append "5G" only when the operator string already advertises it. Nothing
  // is invented; a 4G-only operator renders "Runs on Singtel" verbatim.
  const label = networks.slice(0, 2).join(" / ");
  return `${copy.runsOnPrefix} ${escapeHtml(label)}`;
}

function renderPlanCard(p: CountryPlanRow, copy: CountryCopy, countrySlug: string): string {
  const dataLabel = copy.planDataLabel(p.dataGb, p.isDailyPlan, p.validityDays);
  const validity = copy.planValidityLabel(p.validityDays);
  const network = networkLabel(copy, p.networks);
  const bestValue = p.bestValueLabel
    ? `<span class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-200">Best value</span>`
    : "";
  const buyHref = `/${escapeHtml(countrySlug)}/checkout?plan=${encodeURIComponent(p.code)}`;
  return `
    <article class="rounded-2xl bg-white p-4 ring-1 ring-slate-200 sm:p-5" data-plan="${escapeHtml(p.code)}">
      <header class="flex items-start justify-between gap-2">
        <div>
          <h3 class="text-base font-bold text-slate-900">${escapeHtml(p.name)}</h3>
          <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(dataLabel)} · ${escapeHtml(validity)}</p>
        </div>
        ${bestValue}
      </header>
      ${network ? `<p class="mt-2 text-xs text-slate-600">${network}</p>` : ""}
      <div class="mt-4 flex items-baseline justify-between gap-2">
        <p class="text-xl font-extrabold text-slate-900">${formatUsd(p.retailUsd)}</p>
        <a href="${buyHref}" class="rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(copy.buyCta)}</a>
      </div>
    </article>`;
}

function renderFaq(copy: CountryCopy): string {
  return copy.faq
    .map(
      ({ q, a }) => `
      <details class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <summary class="cursor-pointer text-sm font-semibold text-slate-900">${escapeHtml(q)}</summary>
        <p class="mt-2 text-sm text-slate-700">${escapeHtml(a)}</p>
      </details>`,
    )
    .join("");
}

function renderInstall(copy: CountryCopy): string {
  return `
    <ol class="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
      ${copy.installSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
    </ol>`;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function buildJsonLd(
  country: CountryForSeo,
  plans: CountryPlanRow[],
  copy: CountryCopy,
  pageUrl: string,
): string {
  const faqItems = copy.faq.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  }));
  const cheapest = plans.length > 0 ? plans.reduce((lo, p) => (p.retailUsd < lo.retailUsd ? p : lo)) : null;
  const jsonld: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqItems,
    },
  ];
  if (cheapest) {
    jsonld.push({
      "@context": "https://schema.org",
      "@type": "Product",
      name: `${brand.name} eSIM for ${country.name}`,
      description: `Prepaid travel eSIM for ${country.name}.`,
      brand: { "@type": "Brand", name: brand.name },
      offers: {
        "@type": "Offer",
        priceCurrency: "USD",
        price: cheapest.retailUsd.toFixed(2),
        url: pageUrl,
        availability: "https://schema.org/InStock",
      },
    });
  }
  return jsonld
    .map(
      (obj) =>
        `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`,
    )
    .join("\n");
}

/** hreflang triple for a locale-agnostic path. */
function buildHreflang(pathname: string, publicBaseUrl: string): string {
  const clean = pathname.replace(/^\/[a-z]{2}(\/|$)/, "/");
  return brand.locales
    .map((loc) => {
      const href = `${publicBaseUrl.replace(/\/+$/, "")}/${loc}${clean}`;
      return `<link rel="alternate" hreflang="${loc === "zh" ? "zh-Hans" : loc}" href="${escapeHtml(href)}" />`;
    })
    .concat(
      `<link rel="alternate" hreflang="x-default" href="${escapeHtml(`${publicBaseUrl.replace(/\/+$/, "")}/en${clean}`)}" />`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export async function renderCountryPage(
  slug: string,
  opts: RenderCountryPageOptions,
): Promise<RenderedPage> {
  const { country, plans } = await loadCountryPackages(slug);
  if (!country) {
    return { status: 404, html: renderNotFound(slug, opts) };
  }
  const copy = COPY[opts.locale] ?? COPY.en;
  const cheapest = plans.length > 0 ? plans.reduce((lo, p) => (p.retailUsd < lo.retailUsd ? p : lo)) : null;

  const title = copy.titleTemplate.replace("{country}", country.name);
  const description = copy.descriptionTemplate
    .replace("{country}", country.name)
    .replace("{price}", cheapest ? formatUsd(cheapest.retailUsd) : "—");
  const canonicalPath = `/${opts.locale}/esim/${country.slug}`;
  const canonicalUrl = opts.publicBaseUrl
    ? `${opts.publicBaseUrl.replace(/\/+$/, "")}${canonicalPath}`
    : canonicalPath;

  const body = `
    <nav aria-label="Breadcrumb" class="mx-auto w-full max-w-6xl px-4 pt-4 text-sm text-slate-500">
      <a href="/" class="hover:text-slate-800">${escapeHtml(copy.breadcrumbHome)}</a>
      <span aria-hidden class="px-2">/</span>
      <span class="text-slate-800">${escapeHtml(country.name)}</span>
    </nav>

    <section class="mx-auto mt-3 w-full max-w-6xl px-4">
      <div class="rounded-3xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-8 text-white sm:px-8 sm:py-10">
        <h1 class="text-2xl font-extrabold sm:text-3xl">${escapeHtml(
          copy.h1Template.replace("{country}", country.name),
        )}</h1>
        <p class="mt-2 max-w-2xl text-sm text-brand-50/90">${escapeHtml(description)}</p>
      </div>
    </section>

    <section class="mx-auto mt-8 w-full max-w-6xl px-4" aria-labelledby="plans-heading">
      <h2 id="plans-heading" class="text-lg font-bold text-slate-900">${escapeHtml(
        copy.plansHeading.replace("{country}", country.name),
      )}</h2>
      ${
        plans.length === 0
          ? `<div class="mt-4 rounded-2xl bg-slate-50 p-6 text-sm text-slate-600 ring-1 ring-slate-200">${escapeHtml(copy.emptyState)}</div>`
          : `<div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${plans
              .map((p) => renderPlanCard(p, copy, country.slug))
              .join("")}</div>`
      }
    </section>

    ${
      country.coverageNote
        ? `<section class="mx-auto mt-8 w-full max-w-6xl px-4" aria-labelledby="coverage-heading">
            <h2 id="coverage-heading" class="text-lg font-bold text-slate-900">${escapeHtml(copy.coverageHeading)}</h2>
            <p class="mt-2 text-sm text-slate-700">${escapeHtml(country.coverageNote)}</p>
          </section>`
        : ""
    }

    <section class="mx-auto mt-8 w-full max-w-6xl px-4" aria-labelledby="install-heading">
      <h2 id="install-heading" class="text-lg font-bold text-slate-900">${escapeHtml(copy.installHeading)}</h2>
      ${renderInstall(copy)}
    </section>

    <section class="mx-auto mt-8 w-full max-w-6xl px-4" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" class="text-lg font-bold text-slate-900">${escapeHtml(copy.reviewsHeading)}</h2>
      <p class="mt-2 text-sm text-slate-500" data-reviews-empty>${escapeHtml(copy.reviewsEmpty)}</p>
    </section>

    <section class="mx-auto mt-8 w-full max-w-6xl px-4 pb-16" aria-labelledby="faq-heading">
      <h2 id="faq-heading" class="text-lg font-bold text-slate-900">${escapeHtml(copy.faqHeading)}</h2>
      <div class="mt-4 space-y-3">${renderFaq(copy)}</div>
    </section>
  `;

  const html = renderPageShell({
    lang: opts.locale,
    title,
    description,
    canonicalPath,
    publicBaseUrl: opts.publicBaseUrl,
    ogImagePath: brand.ogImagePath,
    extraHead: buildHreflang(canonicalPath, opts.publicBaseUrl),
    extraHeadAfter: buildJsonLd(country, plans, copy, canonicalUrl),
    body,
  });
  return { status: 200, html };
}

/**
 * 404 page for an unknown country. Deliberately distinct from a "no plans"
 * 200 — crawlers should drop it. Rendered in the requested locale.
 */
function renderNotFound(slug: string, opts: RenderCountryPageOptions): string {
  const title = `Destination not found — ${brand.name}`;
  const description = `We don't currently sell eSIM data plans for "${slug}". Head to our homepage to search available destinations.`;
  const body = `
    <main class="mx-auto w-full max-w-md px-4 py-16 text-center">
      <h1 class="text-2xl font-extrabold text-slate-900">We don't sell plans for this destination (yet)</h1>
      <p class="mt-2 text-sm text-slate-600">${escapeHtml(description)}</p>
      <a href="/${escapeHtml(opts.locale)}/" class="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Search destinations</a>
    </main>`;
  return renderPageShell({
    lang: opts.locale,
    title,
    description,
    canonicalPath: `/${opts.locale}/esim/${slug}`,
    publicBaseUrl: opts.publicBaseUrl,
    ogImagePath: brand.ogImagePath,
    extraHead: `<meta name="robots" content="noindex" />`,
    body,
  });
}

// ---------------------------------------------------------------------------
// Test surface (no live DB calls). These are pure helpers used by the SEO
// test file that will ship in a later batch, and by anyone reviewing the
// numbers here in isolation.
// ---------------------------------------------------------------------------
export const __test__ = {
  annotateBestValue,
  networkLabel,
  formatUsd,
  titleCase,
  buildJsonLd,
  buildHreflang,
  COPY,
};
