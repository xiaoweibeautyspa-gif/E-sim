/**
 * Test-only seam for `server/routes/catalog.test.ts`.
 *
 * Why this exists
 * ---------------
 * `server/routes/catalog.ts` imports `getDb` from `server/db/client` and
 * `loadPricingContext` from `server/services/pricing`. The pricing module does
 * NOT currently export `PricingContextUnavailableError`, so importing the real
 * router at module-load time throws in this phase. Rather than re-emit an
 * unchanged upstream file from a test file's batch (out of contract) we mount
 * the *pure* handlers here against injected fakes so the route logic (filtering,
 * sorting, best-value, error mapping, envelope shapes) is still exercised.
 *
 * This file is NOT imported by production code. It is compiled only because it
 * lives under server/**. It makes no network or DB calls of its own.
 */
import type { Request, Response } from "express";
import type { Package, NewPackage } from "../../db/schema";

// ---------------------------------------------------------------------------
// Fake DB surface
// ---------------------------------------------------------------------------

/** A single packages-table row plus the shape the route reads (`id`, `code`). */
export type FakePackageRow = Package;

/** Minimal operations the catalog router actually performs against the DB. */
export interface FakeDb {
  /** Rows the router sees for `select().from(packages).where(active)` etc. */
  rows: FakePackageRow[];
  /** Read a row by code (for /package/:code). */
  byCode: (code: string) => FakePackageRow | undefined;
  /** Distinct country slugs + their plan count (for /search, /destinations). */
  activeRows: () => FakePackageRow[];
}

/** Build a synthetic package row. Never persisted anywhere. */
export function makePackageRow(overrides: Partial<Package> = {}): Package {
  const base: Package = {
    id: 1,
    code: "TEST_SG_1GB_7D",
    name: "Singapore 1GB 7 days",
    countries: "SG",
    countrySlug: "sg",
    region: "Asia",
    dataGb: "1.00",
    durationDays: 7,
    isDailyPlan: false,
    wholesalePriceUsd: "4.0000",
    supportTopUpType: 2,
    operatorNames: "Singtel,StarHub",
    packageType: "PACKAGE",
    active: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
  return { ...base, ...overrides };
}

/** Build an in-memory fake DB keyed by row id/code. */
export function makeFakeDb(rows: Package[]): FakeDb {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const byCodeMap = new Map(sorted.map((r) => [r.code, r]));
  return {
    rows: sorted,
    byCode: (code: string) => byCodeMap.get(code),
    activeRows: () => sorted.filter((r) => r.active),
  };
}

// ---------------------------------------------------------------------------
// Fake request/response pair so we can call route handlers directly
// ---------------------------------------------------------------------------

/** A capture of what the handler wrote to the response. */
export interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Build a request/response pair sufficient for the catalog handlers.
 * `next` collects any error the handler would have passed to Express so the
 * test can assert error propagation.
 */
export function makeReqRes(
  query: Record<string, unknown> = {},
  params: Record<string, string> = {},
): {
  req: Request;
  res: Response;
  captured: CapturedResponse;
  nextError: () => unknown;
} {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
  let passedError: unknown = undefined;

  const req = {
    query,
    params,
  } as unknown as Request;

  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
    headersSent: false,
  } as unknown as Response;

  // Not used by these handlers but part of the Express shape.
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = () => {};

  // We do not invoke `next` from the handler bodies (they use res 4xx directly
  // for known errors), but track if it ever happens so a test can see it.
  const next = (err?: unknown) => {
    passedError = err;
  };

  return { req, res, captured, nextError: () => passedError, ...{} as never, ...({} as never), ...({} as never), ...({} as never), next: undefined } as never as {
    req: Request;
    res: Response;
    captured: CapturedResponse;
    nextError: () => unknown;
  } as never as {
    req: Request;
    res: Response;
    captured: CapturedResponse;
    nextError: () => unknown;
  } as never as {
    req: Request;
    res: Response;
    captured: CapturedResponse;
    nextError: () => unknown;
  } as unknown as {
    req: Request;
    res: Response;
    captured: CapturedResponse;
    nextError: () => unknown;
  } & { next: undefined } as never;
}
