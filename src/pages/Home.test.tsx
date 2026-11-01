/**
 * Smoke tests for the homepage.
 *
 * These are source-visible assertions that can be run in a later phase when a
 * test renderer (Vitest + Testing Library) is wired into the build. They are
 * NOT executed here (the project’s current `npm test` script runs only
 * `node --test` over server-side tests). They exist so the homepage contract
 * (real API calls, explicit state branches) is checked once tooling lands.
 */
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Home } from "./Home";
import * as apiClientModule from "../lib/apiClient";

describe("Home", () => {
  it("renders the hero, how-it-works and popular section headings", async () => {
    // Stub only the transport layer so the page exercises its real state machine.
    (apiClientModule.apiClient.listDestinations as unknown as () => Promise<unknown>) =
      async () => [{ slug: "sg", plans: 3, minPriceUsd: 3.9 }];
    (apiClientModule.apiClient.listRegionalPlans as unknown as () => Promise<unknown>) =
      async () => [];
    (apiClientModule.apiClient.listGlobalPlans as unknown as () => Promise<unknown>) =
      async () => [];
    (apiClientModule.apiClient.listDailyPlans as unknown as () => Promise<unknown>) =
      async () => [];

    render(<Home />);
    expect(screen.getByText(/Instant travel data/i)).toBeTruthy();
    expect(screen.getByText("How eSIM works")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("destination-sg")).toBeTruthy());
  });

  it("shows a per-section error with a retry button when the API fails", async () => {
    (apiClientModule.apiClient.listDestinations as unknown as () => Promise<unknown>) =
      async () => {
        throw new Error("boom");
      };
    (apiClientModule.apiClient.listRegionalPlans as unknown as () => Promise<unknown>) =
      async () => [];
    (apiClientModule.apiClient.listGlobalPlans as unknown as () => Promise<unknown>) =
      async () => [];
    (apiClientModule.apiClient.listDailyPlans as unknown as () => Promise<unknown>) =
      async () => [];

    render(<Home />);
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(screen.getByText("Try again")).toBeTruthy();
  });
});
