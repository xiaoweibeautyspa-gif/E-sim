/**
 * Admin data tables — /admin/data-tables.
 *
 * Editable lookup tables used across the storefront:
 *   - Phone compatibility list (brand/model list, admin-editable, phase 4)
 *   - Carrier roaming prices (roaming savings calculator, phase 7)
 *   - Network speed ratings (shown on plan cards, phase 7)
 *   - Affiliate IDs (travel affiliate link IDs for the trip planner, phase 5)
 *
 * Each table is:
 *   GET  /api/admin/tables/:name            → { rows: Row[] }
 *   POST /api/admin/tables/:name            → { row: Row }        (insert)
 *   PUT  /api/admin/tables/:name/:id        → { row: Row }        (update)
 *   DELETE /api/admin/tables/:name/:id      → { ok:true, data:{ deleted:true } }
 *
 * The shape of each row is table-specific; the UI renders a generic
 * column-driven table (TABLES below is the single source of truth for
 * columns, types and the admin-side hint). New tables are added by adding an
 * entry to TABLES.
 *
 * HONESTY RULES
 * -------------
 *   - We show exactly what the API returns; a broken table (Maybe.unavailable)
 *     reports the reason for that table only.
 *   - Inserts and edits hit real endpoints. When the endpoint is not wired
 *     (e.g. the affiliate-IDs table is filled by trips, not this page) we
 *     surface the server message instead of a fake "saved".
 *   - Deleting is a real DELETE.
 */
import { useCallback, useEffect, useState } from "react";
import { brand } from "../../server/brand.config";
import type { Maybe } from "../../server/services/adminMetrics";

// ---------------------------------------------------------------------------
// Table definitions (single source of truth for columns)
// ---------------------------------------------------------------------------

export type ColumnType = "text" | "number" | "boolean" | "select";

export interface TableColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** For select columns. */
  options?: { value: string; label: string }[];
  /** Read-only columns (id, audit) — rendered but not editable. */
  readOnly?: boolean;
  hint?: string;
}

export interface TableDef {
  /** API path segment: /api/admin/tables/<key>. */
  key: string;
  title: string;
  description: string;
  columns: TableColumn[];
}

export const TABLES: TableDef[] = [
  {
    key: "phone-models",
    title: "Phone compatibility",
    description:
      "Brands and models confirmed to support eSIM. The public checker reads this list.",
    columns: [
      { key: "brand", label: "Brand", type: "text" },
      { key: "model", label: "Model", type: "text" },
      {
        key: "esimSupport",
        label: "eSIM support",
        type: "select",
        options: [
          { value: "full", label: "Full" },
          { value: "limited", label: "Limited" },
          { value: "none", label: "None" },
        ],
      },
      { key: "notes", label: "Notes", type: "text" },
    ],
  },
  {
    key: "roaming-prices",
    title: "Carrier roaming prices",
    description:
      "Per-carrier, per-country roaming price used by the savings calculator. Use minor units.",
    columns: [
      { key: "carrier", label: "Carrier", type: "text" },
      { key: "country", label: "Country", type: "text" },
      { key: "priceMinor", label: "Price (minor)", type: "number" },
      { key: "currency", label: "Currency", type: "text" },
      { key: "notes", label: "Notes", type: "text" },
    ],
  },
  {
    key: "speed-ratings",
    title: "Network speed ratings",
    description:
      "Per-operator speed rating (1-5) shown on plan cards and country pages.",
    columns: [
      { key: "operator", label: "Operator", type: "text" },
      { key: "country", label: "Country", type: "text" },
      { key: "rating", label: "Rating (1-5)", type: "number" },
      { key: "label", label: "Label", type: "text" },
    ],
  },
  {
    key: "affiliate-ids",
    title: "Affiliate IDs",
    description:
      "Travel-affiliate IDs for hotels, tours, transfers and insurance used in the trip planner's 'Complete your trip' section.",
    columns: [
      {
        key: "partner",
        label: "Partner",
        type: "select",
        options: [
          { value: "hotels", label: "Hotels" },
          { value: "tours", label: "Tours" },
          { value: "transfers", label: "Transfers" },
          { value: "insurance", label: "Insurance" },
        ],
      },
      { key: "affiliateId", label: "Affiliate ID", type: "text" },
      { key: "active", label: "Active", type: "boolean" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

class TableApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "TableApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface ApiOk<T> { ok: true; data: T }
interface ApiErr { ok: false; error: string; message: string }

export interface DataRow {
  id: string | number;
  [key: string]: unknown;
}

async function call<T>(
  fetchImpl: Fetcher,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetchImpl(path, init);
  const json = (await res.json().catch(() => ({}))) as ApiOk<T> | ApiErr | {};
  if (!res.ok || !("ok" in json) || (json as ApiErr).ok === false) {
    const err = json as Partial<ApiErr>;
    throw new TableApiError(
      err.error ?? "request_failed",
      res.status,
      err.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return (json as ApiOk<T>).data;
}

// ---------------------------------------------------------------------------
// One row editor
// ---------------------------------------------------------------------------

function cellInput(
  column: TableColumn,
  value: unknown,
  onChange: (v: unknown) => void,
  disabled: boolean,
): JSX.Element {
  if (column.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        data-col={column.key}
      />
    );
  }
  if (column.type === "select" && column.options) {
    return (
      <select
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
        data-col={column.key}
      >
        <option value="">—</option>
        {column.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={column.type === "number" ? "number" : "text"}
      value={value == null ? "" : String(value)}
      onChange={(e) =>
        onChange(column.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)
      }
      disabled={disabled}
      className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
      data-col={column.key}
    />
  );
}

function EditableRow({
  table,
  row,
  fetchImpl,
  onChanged,
}: {
  table: TableDef;
  row: DataRow;
  fetchImpl: Fetcher;
  onChanged: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<DataRow>(row);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = table.columns.some((c) => !c.readOnly && draft[c.key] !== row[c.key]);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of table.columns) {
        if (!c.readOnly) payload[c.key] = draft[c.key];
      }
      await call<{ row: DataRow }>(
        fetchImpl,
        "PUT",
        `/api/admin/tables/${encodeURIComponent(table.key)}/${encodeURIComponent(String(row.id))}`,
        payload,
      );
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Delete row ${row.id}?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await call(fetchImpl, "DELETE", `/api/admin/tables/${encodeURIComponent(table.key)}/${encodeURIComponent(String(row.id))}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr data-testid={`admin-table-row-${table.key}-${row.id}`}>
      {table.columns.map((c) => (
        <td key={c.key} className="px-2 py-2 align-top">
          {cellInput(
            c,
            draft[c.key],
            (v) => setDraft((d) => ({ ...d, [c.key]: v })),
            busy || c.readOnly === true,
          )}
        </td>
      ))}
      <td className="px-2 py-2 text-right align-top">
        {err && <p className="text-[10px] text-rose-600">{err}</p>}
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="rounded-lg bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function NewRow({ table, fetchImpl, onChanged }: { table: TableDef; fetchImpl: Fetcher; onChanged: () => void }): JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function insert(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of table.columns) {
        if (!c.readOnly) payload[c.key] = draft[c.key] ?? null;
      }
      await call(fetchImpl, "POST", `/api/admin/tables/${encodeURIComponent(table.key)}`, payload);
      setDraft({});
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Insert failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="bg-slate-50" data-testid={`admin-table-newrow-${table.key}`}>
      {table.columns.map((c) => (
        <td key={c.key} className="px-2 py-2">
          {cellInput(
            c,
            draft[c.key],
            (v) => setDraft((d) => ({ ...d, [c.key]: v })),
            busy || c.readOnly === true,
          )}
        </td>
      ))}
      <td className="px-2 py-2 text-right">
        {err && <p className="text-[10px] text-rose-600">{err}</p>}
        <button
          type="button"
          onClick={() => void insert()}
          disabled={busy}
          className="rounded-lg bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          Add
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// One table panel
// ---------------------------------------------------------------------------

type TableState =
  | { status: "loading" }
  | { status: "ready"; value: Maybe<DataRow[]> }
  | { status: "error"; code: string; message: string };

function TablePanel({ table, fetchImpl }: { table: TableDef; fetchImpl: Fetcher }): JSX.Element {
  const [state, setState] = useState<TableState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    call<{ rows: Maybe<DataRow[]> }>(
      fetchImpl,
      "GET",
      `/api/admin/tables/${encodeURIComponent(table.key)}`,
    )
      .then((d) => !cancelled && setState({ status: "ready", value: d.rows }))
      .catch(
        (err: unknown) =>
          !cancelled &&
          setState({
            status: "error",
            code: err instanceof TableApiError ? err.code : "request_failed",
            message: err instanceof Error ? err.message : "Could not load rows.",
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, table.key, nonce]);

  return (
    <section
      className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"
      aria-labelledby={`table-${table.key}-heading`}
      data-testid={`admin-table-${table.key}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`table-${table.key}-heading`} className="text-base font-bold text-slate-900">
            {table.title}
          </h2>
          <p className="mt-1 max-w-prose text-xs text-slate-600">{table.description}</p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {state.status === "loading" && (
        <div className="mt-3 h-20 animate-pulse rounded-xl bg-slate-100" aria-busy />
      )}

      {state.status === "error" && (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          Couldn't load {table.title} ({state.message}).
        </p>
      )}

      {state.status === "ready" && !state.value.available && (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          Couldn't load {table.title} ({state.value.reason}).
        </p>
      )}

      {state.status === "ready" && state.value.available && (
        <div className="mt-3 overflow-x-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-left">
                    {c.label}
                  </th>
                ))}
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.value.value.map((row) => (
                <EditableRow
                  key={row.id}
                  table={table}
                  row={row}
                  fetchImpl={fetchImpl}
                  onChanged={reload}
                />
              ))}
              <NewRow table={table} fetchImpl={fetchImpl} onChanged={reload} />
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface AdminDataTablesProps {
  fetcher?: Fetcher;
}

export function AdminDataTables({ fetcher }: AdminDataTablesProps = {}): JSX.Element {
  const fetchImpl: Fetcher = fetcher ?? ((url, init) => fetch(url, init));

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6" data-testid="admin-data-tables">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {brand.name} · Admin
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Data tables</h1>
        <p className="mt-1 max-w-xl text-sm text-slate-600">
          Editable lookup data. Changes are saved to the database immediately and
          take effect on the next page view.
        </p>
      </header>

      <div className="space-y-6">
        {TABLES.map((t) => (
          <TablePanel key={t.key} table={t} fetchImpl={fetchImpl} />
        ))}
      </div>

      <nav className="mt-8 flex flex-wrap gap-3 text-sm">
        <a href="/admin" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Dashboard
        </a>
        <a href="/admin/orders" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Orders
        </a>
        <a href="/admin/settings" className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          Settings
        </a>
      </nav>
    </main>
  );
}

export const __test__ = { TABLES };

export default AdminDataTables;
