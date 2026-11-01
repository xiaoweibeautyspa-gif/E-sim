/**
 * Drizzle schema fragment for columns added by `0005_esims_gifts.sql`.
 *
 * The real `server/db/schema.ts` was not supplied in this request, so this file
 * declares ONLY the added order columns plus type-safe aliases the fulfilment
 * service can import. Wire it into `server/db/schema.ts` in the next
 * schema-touching batch by re-exporting:
 *
 *     export * from "../migrations/0005_esims_gifts.schema";
 *
 * Nothing here issues SQL — the migration `0005_esims_gifts.sql` does. This
 * file exists so TypeScript sees the columns, tests can reference them, and
 * a future `drizzle-kit generate` sees the shape.
 */
import { pgTable, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/** A gift recipient's rendered message; `null` when the order is not a gift. */
export type OrderGift = {
  recipientName: string;
  recipientEmail: string;
  message?: string | null;
  sendDate?: string | null;
} | null;

/**
 * Additional columns added to `orders` by migration 0005. This is a *view*
 * (pgTable without a primary key) so it doesn't try to re-create the table;
 * it's only used for typed selects in a transitional phase. Replace with a
 * direct extension of the real `orders` definition once the schema file is
 * in the batch's scope.
 */
export const ordersFulfilmentColumns = pgTable(
  "_orders_fulfilment_columns",
  {
    packageCode: varchar("package_code", { length: 128 }),
    supplierOrderNo: varchar("supplier_order_no", { length: 64 }),
    processingReason: text("processing_reason"),
    failedReason: text("failed_reason"),
    gift: jsonb("gift").$type<OrderGift>(),
    sendDate: timestamp("send_date", { withTimezone: true }),
  },
  (t) => ({
    packageCodeIdx: index("orders_package_code_idx").on(t.packageCode),
    supplierOrderNoIdx: index("orders_supplier_order_no_idx").on(t.supplierOrderNo),
    sendDateIdx: index("orders_gift_send_date_idx").on(t.sendDate),
  }),
);

/**
 * Legal order-status values, mirroring the CHECK re-created in migration 0005.
 * Kept in lockstep with `OrderStatus` in `server/services/fulfilment.ts`; if
 * one changes, so must the other.
 */
export type OrderStatus =
  | "waiting_payment"
  | "pending"
  | "pending_fulfilment"
  | "paid"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "refunded"
  | "cancelled";

export const ORDER_STATUS_VALUES: readonly OrderStatus[] = [
  "waiting_payment",
  "pending",
  "pending_fulfilment",
  "paid",
  "processing",
  "completed",
  "failed",
  "expired",
  "refunded",
  "cancelled",
] as const;
