/**
 * Drizzle table definitions for saved trips (phase 14, batch 1).
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * `server/db/schema.ts` was not supplied in this batch's context, so we can't
 * safely append to it. The trip tables are fully self-contained here and only
 * reference `users.id` by *value* (an integer) rather than through a Drizzle
 * FK declaration. That keeps this module import-safe regardless of how
 * `schema.ts` shapes `users` and avoids a circular import. The SQL in
 * `0008_trips.sql` (this batch) still declares a proper FK for the DB.
 *
 * SHAPE NOTES
 * -----------
 * - `id` is a 12-char base32 share token, not a numeric id: `/trip/[id]`
 *   needs to be unguessable so a shared link is safe to publish. We store the
 *   same value in `publicId` (unique) and rely on it in every lookup.
 * - `planText` stores the full streamed text from the AI trip planner. The
 *   route returns it verbatim; the persistence layer never re-parses it
 *   (sections are already delimited by ALL-CAPS headers the client knows).
 * - `meta` keeps non-essential fields (flight, style, language, budget,
 *   affiliates snapshot) as JSONB so we don't reopen the migration for every
 *   small field.
 * - `esimId` ties the trip to the eSIM the user bought from the "Stay
 *   connected" card, so the offline pack can embed the QR. It is nullable —
 *   a trip can be saved before purchase.
 * - `reminderSentAt` is the idempotency key for the departure-reminder job
 *   (queued). `departureDate` is what that job scans.
 * - `ownerEmail` is denormalised so a guest (userId NULL) can still receive
 *   the reminder without signing up. It is the email the planner page
 *   collected at save time.
 */
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const trips = pgTable(
  "trips",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    /** Public share id: 12-char base32 (see generateShareId). Unique. */
    publicId: text("public_id").notNull(),
    /** Owning user id, or NULL for a guest save (single trip per email). */
    userId: integer("user_id"),
    /** Owner email — always set so reminders can reach guests too. */
    ownerEmail: text("owner_email").notNull(),
    /** Countries the trip covers (lowercase slugs or region names). */
    countries: jsonb("countries").$type<string[]>().notNull(),
    startDate: text("start_date").notNull(), // YYYY-MM-DD
    endDate: text("end_date").notNull(), // YYYY-MM-DD
    /** Same as startDate; kept separately for the reminder job's scan. */
    departureDate: text("departure_date").notNull(),
    style: text("style").notNull(),
    language: text("language").notNull(),
    /** Full streamed text from /api/trip-planner/plan. Sections in order. */
    planText: text("plan_text").notNull(),
    /** Structured extras (flight, budget, affiliates snapshot, prompt input). */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull(),
    /** eSIM the user bought from "Stay connected", if any. */
    esimId: integer("esim_id"),
    /** Whether this trip is visible at /trip/[publicId]. Defaults to public. */
    isPublic: boolean("is_public").notNull().default(true),
    /** Departure reminder idempotency key (queued job). */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    publicIdIdx: uniqueIndex("trips_public_id_uq").on(t.publicId),
    userIdx: index("trips_user_idx").on(t.userId),
    departureIdx: index("trips_departure_idx").on(t.departureDate),
  }),
);

export type Trip = typeof trips.$inferSelect;
export type NewTrip = typeof trips.$inferInsert;
