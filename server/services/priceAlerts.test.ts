/**
 * Unit tests for `server/services/priceAlerts.ts` — price-drop alert
 * subscriptions (Phase 19 lifecycle/alerts).
 *
 * WHAT THESE PROVE (mapped to the phase acceptance criterion
 * "price-drop alert notifies subscribers when price falls")
 * -------------------------------------------------------------------
 *   1. Pure helpers (`__test__`):
 *      - normaliseEmail / normaliseCountry trim + lowercase
 *      - toMoney rounds to 4 decimals
 *      - formatPrice handles SGD/USD/VND/CNY
 *      - convertForDisplay never invents an FX rate (falls back to USD)
 *      - EMAIL_RE / COUNTRY_RE validation
 *   2. Email template (`buildPriceDropEmail`):
 *      - includes old price, new price, country, absolute CTA to /esim/<cc>
 *      - escapes interpolated values
 *   3. subscribePriceAlert():
 *      - rejects invalid email / country BEFORE touching the DB
 *      - returns db_unavailable when there is no pool
 *      - reports `created` from the RETURNING `xmax = 0` column
 *   4. notifyPriceDropsForCountry():
 *      - no packages for the country → no notify, currentPrice = null
 *      - no subscription rows → checked = 0
 *      - STRICTLY lower price → notifies exactly once and updates the row
 *      - price unchanged / higher → never notifies
 *      - a failing sendEmail leaves the row un-notified (retry next sync)
 *        and never throws
 *      - email carries the subscriber address + price-alert category
 *
 * WHAT THESE DO NOT PROVE
 * -----------------------
 *   - Postgres behaviour (UNIQUE, ON CONFLICT, `xmax`). The DB is faked; the
 *     real schema is exercised by the end-to-end flow phase.
 *   - The catalog-sync caller that invokes notifyPriceDropsForCountry — that
 *     wiring lives in `catalogSync.ts` and is covered separately.
 *   - Real SMTP — `sendEmail` is injected here.
 *
 * HOW THE FAKE DB WORKS
 * ---------------------
 * `priceAlerts.ts` calls `getDb()` internally (it is not an injection point),
 * so we register a module hook that resolves `../db/client` to a fake whose
 * `getDb()` returns a fake Drizzle-like client. The fake `execute()` inspects
 * the drizzle `SQL` object's query chunks (which is how drizzle represents
 * `sql\`SELECT ...\``) and routes to a tiny in-memory store. This lets us
 * drive the REAL service functions, not a reimplementation.
 *
 * SAFETY: no network, no DATABASE_URL, no secrets. Run with:
 *     npm test
 * (node --test --import tsx "server/**\/*.test.ts")
 *
 * These are SOURCE tests — not executed by this response.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Module hook: resolve `../db/client` (as imported by priceAlerts.ts) to a
// fake. The hook file is generated on disk once at import time to avoid
// needing a second committed file. We only do this when a real DB would
// otherwise be imported, and we never touch DATABASE_URL.
//
// The hook is a no-op for every other specifier.
// ---------------------------------------------------------------------------

const HOOK_SOURCE = `
import { register } from "node:module";
// The registration hook installed by the test file stores the fake getDb on
// globalThis so this hook can pick it up without a URL round-trip.
const FAKE_KEY = "__priceAlertsFakeDbClient__";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/db/client") || specifier.endsWith("db/client.ts") || specifier === "../db/client" || specifier === "../db/client.ts") {
    return { url: "fake-db-client://", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === "fake-db-client://") {
    const source = \`
      const KEY = "\${FAKE_KEY}";
      function getFake() { return globalThis[KEY] ?? null; }
      export function getDb() { return getFake(); }
      export function getPool() { const f = getFake(); return f ? (f.__pool ?? null) : null; }
      export const pool = null;
    \`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

// Register the hook using a data: URL so we never create a filesystem artifact.
register(
  "data:text/javascript," + encodeURIComponent(HOOK_SOURCE),
  pathToFileURL(process.cwd() + "/"),
);

// Now import the service under test (it will get the faked db client).
import {
  subscribePriceAlert,
  notifyPriceDropsForCountry,
  buildPriceDropEmail,
  listAlertableCountries,
  type PriceAlertCurrency,
  type SendEmailFn,
  __test__,
} from "./priceAlerts";

// ---------------------------------------------------------------------------
// Fake Drizzle-like `execute()`.
//
// priceAlerts.ts only issues `sql\`…\`` queries via `db.execute(sql\`…\`)`
// with embedded parameters. Drizzle's `sql` object exposes `.queryChunks`
// where string chunks and Param chunks alternate. We join the string chunks
// to identify the statement family, then read the parameter values from the
// Param chunks in order. This is stable across the specific templates the
// service uses (SELECT cheapest, SELECT subscriptions, UPDATE one row,
// DELETE by (country,email), INSERT..ON CONFLICT..RETURNING, etc.).
// ---------------------------------------------------------------------------

interface ParamLike {
  value?: unknown;
}
interface ChunkLike {
  value?: unknown;
  queryChunks?: unknown;
}

function sqlTextAndParams(query: unknown): { text: string; params: unknown[] } {
  const chunks = (query as { queryChunks?: ChunkLike[] } | null)?.queryChunks ?? [];
  let text = "";
  const params: unknown[] = [];
  for (const c of chunks) {
    if (typeof c === "string") {
      text += c;
      continue;
    }
    if (c && typeof c === "object" && "value" in c) {
      // Param chunk: a `{ value }` object holding the bound parameter.
      params.push((c as ParamLike).value);
      text += " ? ";
      continue;
    }
    // Nested SQL (e.g. `LOWER(country_code) = ${x}`) iterates recursively.
    if (c && typeof c === "object" && Array.isArray((c as ChunkLike).queryChunks)) {
      const inner = sqlTextAndParams(c);
      text += inner.text;
      params.push(...inner.params);
      continue;
    }
    // Unknown chunk — keep the text stable so classification still works.
    text += " ? ";
  }
  return { text: text.replace(/\s+/g, " ").trim(), params };
}

interface SubRow {
  id: number;
  country_code: string;
  email: string;
  user_id: number | null;
  currency: string;
  last_seen_price: number;
  last_notified_price: number | null;
  created_at: string;
  updated_at: string;
}

interface FakeState {
  /** country_code → cheapest retail USD price (or null = no packages). */
  cheapestByCountry: Map<string, number | null>;
  /** Live subscription rows, keyed by `country|email`. */
  subs: Map<string, SubRow>;
  nextId: number;
  /** Every SQL statement we saw, for assertion + debugging. */
  log: Array<{ kind: string; text: string; params: unknown[] }>;
}

function makeFakeState(): FakeState {
  return {
    cheapestByCountry: new Map(),
    subs: new Map(),
    nextId: 1,
    log: [],
  };
}

function subKey(country: string, email: string): string {
  return `${country.toLowerCase()}|${email.toLowerCase()}`;
}

function classify(text: string): string {
  const t = text.toUpperCase();
  if (t.includes("MIN(RETAIL_PRICE_USD)")) return "cheapest";
  if (t.startsWith("INSERT INTO PRICE_ALERT_SUBSCRIPTIONS")) return "insert_sub";
  if (t.startsWith("SELECT ID, COUNTRY_CODE") && t.includes("FROM PRICE_ALERT_SUBSCRIPTIONS")) {
    if (t.includes("WHERE USER_ID")) return "select_user";
    return "select_country";
  }
  if (t.startsWith("UPDATE PRICE_ALERT_SUBSCRIPTIONS")) return "update_sub";
  if (t.startsWith("DELETE FROM PRICE_ALERT_SUBSCRIPTIONS")) return "delete_sub";
  if (t.includes("COUNT(*)") && t.includes("FROM PACKAGES")) return "alertable_countries";
  return "unknown";
}

function makeFakeDb(state: FakeState) {
  const db = {
    async execute(query: unknown): Promise<{ rows: unknown[] }> {
      const { text, params } = sqlTextAndParams(query);
      const kind = classify(text);
      state.log.push({ kind, text, params });

      switch (kind) {
        case "cheapest": {
          const countryCode = String(params[0] ?? "").toLowerCase();
          const v = state.cheapestByCountry.get(countryCode);
          if (v == null) return { rows: [{ min_price: null }] };
          return { rows: [{ min_price: v }] };
        }

        case "select_country": {
          const countryCode = String(params[0] ?? "").toLowerCase();
          const priceUsd = Number(params[1]);
          const rows = Array.from(state.subs.values())
            .filter(
              (r) =>
                r.country_code === countryCode &&
                r.last_seen_price > priceUsd &&
                (r.last_notified_price == null || r.last_notified_price > priceUsd),
            )
            .sort((a, b) => b.last_seen_price - a.last_seen_price)
            .slice(0, 500);
          return { rows };
        }

        case "select_user": {
          const userId = Number(params[0]);
          const rows = Array.from(state.subs.values()).filter((r) => r.user_id === userId);
          return { rows };
        }

        case "insert_sub": {
          // Params in order: country_code, email, user_id, currency, last_seen_price.
          const [countryCode, email, userId, currency, baseline] = params as [
            string,
            string,
            number | null,
            string,
            number,
          ];
          const key = subKey(countryCode, email);
          const existing = state.subs.get(key);
          const now = new Date().toISOString();
          if (existing) {
            existing.user_id = existing.user_id ?? userId ?? null;
            existing.currency = currency;
            existing.last_seen_price = Math.min(existing.last_seen_price, baseline);
            existing.updated_at = now;
            return { rows: [{ ...existing, created: false }] };
          }
          const row: SubRow = {
            id: state.nextId++,
            country_code: countryCode,
            email,
            user_id: userId ?? null,
            currency,
            last_seen_price: baseline,
            last_notified_price: null,
            created_at: now,
            updated_at: now,
          };
          state.subs.set(key, row);
          return { rows: [{ ...row, created: true }] };
        }

        case "update_sub": {
          // Params in order: last_notified_price, amount, updated_at, id.
          const [amount1, amount2, at, id] = params as [number, number, string, number];
          // `amount1`/`amount2` are both the same amount in the current template.
          const amount = amount1;
          void amount2;
          const target = Array.from(state.subs.values()).find((r) => r.id === id);
          if (target) {
            target.last_notified_price = amount;
            target.last_seen_price = Math.min(target.last_seen_price, amount);
            target.updated_at = String(at);
          }
          return { rows: [] };
        }

        case "delete_sub": {
          const [countryCode, email] = params as [string, string];
          state.subs.delete(subKey(countryCode, email));
          return { rows: [] };
        }

        case "alertable_countries": {
          // Distinct non-topup country codes from packages; the fake returns
          // every country the test planted (rising count 1 per entry).
          const rows = Array.from(state.cheapestByCountry.keys())
            .filter((c) => state.cheapestByCountry.get(c) != null)
            .map((c) => ({ country_code: c, plan_count: 1 }));
          return { rows };
        }

        default:
          return { rows: [] };
      }
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------

interface Harness {
  state: FakeState;
  sentEmails: Array<{ to: string; subject: string; html: string; text?: string; category?: string }>;
  sendEmail: SendEmailFn;
}

function setup(): Harness {
  const state = makeFakeState();
  const db = makeFakeDb(state);
  // Publish the fake on the global the module hook reads.
  (
    globalThis as unknown as Record<string, unknown>
  ).__priceAlertsFakeDbClient__ = () => db;

  const sentEmails: Harness["sentEmails"] = [];
  const sendEmail: SendEmailFn = async (input) => {
    sentEmails.push(input);
  };
  return { state, sentEmails, sendEmail };
}

function teardown(): void {
  delete (globalThis as unknown as Record<string, unknown>).__priceAlertsFakeDbClient__;
}

function setNoDb(): void {
  (globalThis as unknown as Record<string, unknown>).__priceAlertsFakeDbClient__ = () => null;
}

function plantSub(
  state: FakeState,
  input: {
    countryCode: string;
    email: string;
    lastSeenPrice: number;
    lastNotifiedPrice?: number | null;
    currency?: PriceAlertCurrency;
    userId?: number | null;
  },
): SubRow {
  const row: SubRow = {
    id: state.nextId++,
    country_code: input.countryCode.toLowerCase(),
    email: input.email.toLowerCase(),
    user_id: input.userId ?? null,
    currency: input.currency ?? "USD",
    last_seen_price: input.lastSeenPrice,
    last_notified_price: input.lastNotifiedPrice ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.subs.set(subKey(row.country_code, row.email), row);
  return row;
}

const PUBLIC_BASE = "https://shop.example.test";
const FIXED_NOW = () => new Date("2024-06-15T12:00:00Z");

beforeEach(() => {
  teardown();
});

// ===========================================================================
// 1) Pure helpers via __test__
// ===========================================================================

test("normaliseEmail lower-cases and trims", () => {
  assert.equal(__test__.normaliseEmail("  Foo@Example.COM "), "foo@example.com");
});

test("normaliseCountry lower-cases and trims", () => {
  assert.equal(__test__.normaliseCountry("  SG "), "sg");
});

test("toMoney rounds to 4 decimals", () => {
  assert.equal(__test__.toMoney(1.23456789), 1.2346);
  assert.equal(__test__.toMoney(0), 0);
});

test("formatPrice renders USD/SGD/CNY with symbols and VND without decimals", () => {
  assert.match(__test__.formatPrice(9.9, "USD"), /\$9\.90/);
  assert.match(__test__.formatPrice(9.9, "SGD"), /S\$9\.90/);
  assert.match(__test__.formatPrice(9.9, "CNY"), /¥9\.90/);
  // VND string must carry the ₫ glyph and be integer-rounded (no .00).
  const vnd = __test__.formatPrice(99000, "VND");
  assert.match(vnd, /99000/);
  assert.match(vnd, /₫/);
  assert.doesNotMatch(vnd, /\.00/);
});

test("convertForDisplay never invents an FX rate; non-USD returns USD", () => {
  assert.deepEqual(__test__.convertForDisplay(9.9, "USD"), { amount: 9.9, currency: "USD" });
  // Subscriber picked SGD but we only price in USD → fall back to USD.
  assert.deepEqual(__test__.convertForDisplay(9.9, "SGD"), { amount: 9.9, currency: "USD" });
  assert.deepEqual(__test__.convertForDisplay(9.9, "VND"), { amount: 9.9, currency: "USD" });
});

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(
    __test__.escapeHtml('<a href="x">&\'A\'</a>'),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;A&#39;&lt;/a&gt;",
  );
});

test("EMAIL_RE and COUNTRY_RE validate correct shapes", () => {
  assert.equal(__test__.EMAIL_RE.test("a@b.co"), true);
  assert.equal(__test__.EMAIL_RE.test("no-at-symbol"), false);
  assert.equal(__test__.COUNTRY_RE.test("sg"), true);
  assert.equal(__test__.COUNTRY_RE.test("SGP"), false);
  assert.equal(__test__.COUNTRY_RE.test("s1"), false);
});

// ===========================================================================
// 2) Email template
// ===========================================================================

test("buildPriceDropEmail carries old price, new price, country and absolute CTA", () => {
  const email = buildPriceDropEmail({
    countryCode: "sg",
    oldPrice: 12,
    newPrice: 8.5,
    currency: "USD",
    publicBaseUrl: PUBLIC_BASE,
  });
  assert.match(email.subject, /SG/);
  assert.match(email.subject, /\$8\.50/);
  assert.match(email.html, /\$12\.00/);
  assert.match(email.html, /\$8\.50/);
  assert.match(email.html, /href="https:\/\/shop\.example\.test\/esim\/sg"/);
  assert.match(email.text, /\$8\.50/);
  assert.match(email.text, /https:\/\/shop\.example\.test\/esim\/sg/);
});

test("buildPriceDropEmail escapes the country code (never injects HTML)", () => {
  // A hostile country code (shouldn't happen — but escape anyway).
  const email = buildPriceDropEmail({
    countryCode: "<script>",
    oldPrice: 1,
    newPrice: 0.5,
    currency: "USD",
    publicBaseUrl: PUBLIC_BASE,
  });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
});

// ===========================================================================
// 3) subscribePriceAlert
// ===========================================================================

test("subscribePriceAlert rejects an invalid email before touching the DB", async () => {
  const { state } = setup();
  const result = await subscribePriceAlert({
    email: "not-an-email",
    countryCode: "sg",
    lastSeenPrice: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_email");
  // No DB calls issued.
  assert.equal(state.log.length, 0);
});

test("subscribePriceAlert rejects an invalid country before touching the DB", async () => {
  const { state } = setup();
  const result = await subscribePriceAlert({
    email: "buyer@example.test",
    countryCode: "SGP",
    lastSeenPrice: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_country");
  assert.equal(state.log.length, 0);
});

test("subscribePriceAlert returns db_unavailable when there is no pool", async () => {
  setNoDb();
  const result = await subscribePriceAlert({
    email: "buyer@example.test",
    countryCode: "sg",
    lastSeenPrice: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "db_unavailable");
});

test("subscribePriceAlert creates a new row and reports created=true", async () => {
  const { state } = setup();
  const result = await subscribePriceAlert({
    email: "Buyer@Example.test",
    countryCode: "SG",
    lastSeenPrice: 10.5,
    currency: "SGD",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const row = state.subs.get("sg|buyer@example.test");
  assert.ok(row, "row must be stored under the normalised key");
  assert.equal(row!.currency, "SGD");
  assert.equal(row!.last_seen_price, 10.5);
});

test("subscribePriceAlert keeps the LOWER baseline on repeat calls (so a drop still fires)", async () => {
  const { state } = setup();
  await subscribePriceAlert({
    email: "b@example.test",
    countryCode: "sg",
    lastSeenPrice: 12,
  });
  const result = await subscribePriceAlert({
    email: "b@example.test",
    countryCode: "sg",
    lastSeenPrice: 20, // higher — must not overwrite
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(state.subs.get("sg|b@example.test")!.last_seen_price, 12);
});

// ===========================================================================
// 4) notifyPriceDropsForCountry — the core behaviour
// ===========================================================================

test("notifyPriceDropsForCountry does NOT notify when the country has no packages", async () => {
  const { state, sentEmails } = setup();
  plantSub(state, { countryCode: "sg", email: "b@example.test", lastSeenPrice: 12 });
  // No cheapest price planted → null.

  const outcome = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.currentPrice, null);
  assert.equal(outcome.notified, 0);
  assert.equal(sentEmails.length, 0);
  // Subscription is untouched (last_seen_price still 12).
  assert.equal(state.subs.get("sg|b@example.test")!.last_seen_price, 12);
});

test("notifyPriceDropsForCountry only notifies subscribers whose baseline is higher than the current price", async () => {
  const { state, sentEmails } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  // baseline 12 → drop → notify.
  plantSub(state, { countryCode: "sg", email: "drops@example.test", lastSeenPrice: 12 });
  // baseline 5 → no drop → no notify.
  plantSub(state, { countryCode: "sg", email: "steady@example.test", lastSeenPrice: 5 });
  // baseline 8 → unchanged → no notify.
  plantSub(state, { countryCode: "sg", email: "flat@example.test", lastSeenPrice: 8 });

  const outcome = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(outcome.currentPrice, 8.0);
  assert.equal(outcome.notified, 1);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]!.to, "drops@example.test");
  assert.equal(sentEmails[0]!.category, "price-alert");
  assert.match(sentEmails[0]!.subject, /price drop/i);
});

test("notifyPriceDropsForCountry uses strict-less-than so a price rise never notifies", async () => {
  const { state, sentEmails } = setup();
  state.cheapestByCountry.set("sg", 15); // price went UP
  plantSub(state, { countryCode: "sg", email: "b@example.test", lastSeenPrice: 12 });

  const outcome = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.notified, 0);
  assert.equal(sentEmails.length, 0);
});

test("notifyPriceDropsForCountry skips subscribers already notified at this price (last_notified_price)", async () => {
  const { state, sentEmails } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  // Baseline higher than current, but already notified at exactly current:
  plantSub(state, {
    countryCode: "sg",
    email: "b@example.test",
    lastSeenPrice: 12,
    lastNotifiedPrice: 8.0,
  });

  const outcome = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.notified, 0);
  assert.equal(sentEmails.length, 0);
});

test("notifyPriceDropsForCountry updates last_notified_price after a successful send so it can't fire twice", async () => {
  const { state, sentEmails } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  plantSub(state, { countryCode: "sg", email: "b@example.test", lastSeenPrice: 12 });

  // First sweep: notifies.
  const first = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(first.notified, 1);

  // Second sweep at the same price: no more emails — the subscriber's
  // last_notified_price now equals the current price, so the SQL filter
  // excludes the row and we don't double-send.
  const before = sentEmails.length;
  const second = await notifyPriceDropsForCountry("sg", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(second.notified, 0);
  assert.equal(sentEmails.length, before);
  assert.equal(state.subs.get("sg|b@example.test")!.last_notified_price, 8.0);
});

test("notifyPriceDropsForCountry never throws when sendEmail fails; the row stays un-notified (retry next sync)", async () => {
  const { state } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  plantSub(state, { countryCode: "sg", email: "b@example.test", lastSeenPrice: 12 });

  const outcome = await notifyPriceDropsForCountry("sg", {
    sendEmail: async () => {
      throw new Error("SMTP 421 — try again");
    },
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.notified, 0);
  assert.equal(outcome.failed, 1);
  // The row is still pending → last_notified_price stays null.
  assert.equal(state.subs.get("sg|b@example.test")!.last_notified_price, null);
});

test("notifyPriceDropsForCountry is case-insensitive on the country code", async () => {
  const { state, sentEmails } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  plantSub(state, { countryCode: "sg", email: "b@example.test", lastSeenPrice: 12 });

  const outcome = await notifyPriceDropsForCountry("SG", {
    sendEmail: async (input) => void sentEmails.push({ ...input, to: input.to }),
    publicBaseUrl: PUBLIC_BASE,
    now: FIXED_NOW,
    log: () => {},
  });
  assert.equal(outcome.notified, 1);
  assert.equal(sentEmails.length, 1);
});

// ===========================================================================
// 5) listAlertableCountries — only countries that actually have plans
// ===========================================================================

test("listAlertableCountries returns only countries with a non-null cheapest price", async () => {
  const { state } = setup();
  state.cheapestByCountry.set("sg", 8.0);
  state.cheapestByCountry.set("jp", 12.0);
  state.cheapestByCountry.set("zz", null); // no packages

  const countries = await listAlertableCountries();
  const codes = countries.map((c) => c.countryCode).sort();
  assert.deepEqual(codes, ["jp", "sg"]);
});

test("listAlertableCountries returns [] when the DB is unavailable", async () => {
  setNoDb();
  const countries = await listAlertableCountries();
  assert.deepEqual(countries, []);
});
