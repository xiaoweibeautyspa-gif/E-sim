test("USAGE_REFRESH_JOB_INTERVAL_MS is exactly 3 hours and matches the service", () => {
  assert.equal(USAGE_REFRESH_JOB_INTERVAL_MS, 3 * 60 * 60 * 1000);
  assert.equal(USAGE_REFRESH_JOB_INTERVAL_MS, USAGE_REFRESH_INTERVAL_MS);
});
