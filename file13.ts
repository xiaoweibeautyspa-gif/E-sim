test("runImmediately schedules and triggers one background pass", async () => {
  __resetUsageRefreshStateForTests();
  const runs: UsageRefreshRunRecord[] = [];
  startUsageRefresh({
    intervalMs: 90_000,
    runImmediately: true,
    log: () => {},
    onRun: (r) => runs.push(r),
  });
  try {
    // Wait for the fire-and-forget run to settle without hanging the test.
    await waitFor(() => runs.length === 1, 3_000);
    assert.equal(runs.length, 1);
  } finally {
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
});
