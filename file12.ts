test("getLastUsageRefreshRun reflects the most recent attempt", async () => {
  __resetUsageRefreshStateForTests();
  assert.equal(getLastUsageRefreshRun(), null);
  await runUsageRefreshOnce({ intervalMs: 180_000, log: () => {} });
  const last = getLastUsageRefreshRun();
  assert.ok(last, "run must record state");
  assert.ok(last!.finishedAt instanceof Date);
  __resetUsageRefreshStateForTests();
});
