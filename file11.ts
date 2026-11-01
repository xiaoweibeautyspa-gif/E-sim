test("runUsageRefreshOnce returns a record with the expected fields and calls onRun once", async () => {
  __resetUsageRefreshStateForTests();
  const records: UsageRefreshRunRecord[] = [];
  const record = await runUsageRefreshOnce({
    intervalMs: 180_000,
    log: () => {},
    onRun: (r) => records.push(r),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0], record, "onRun receives the same record returned");
  assert.ok(record.startedAt instanceof Date);
  assert.ok(record.finishedAt instanceof Date);
  assert.ok(record.finishedAt.getTime() >= record.startedAt.getTime());
  // result and error are complementary: at least one is populated (success or failure).
  assert.ok(
    record.result !== null || record.error !== null,
    "record must record an outcome: result OR error",
  );
  if (record.result !== null) {
    assert.equal(typeof record.result.attempted, "number");
    assert.equal(typeof record.result.updated, "number");
    assert.equal(typeof record.result.unmatched, "number");
    assert.equal(typeof record.result.batches, "number");
  }
  if (record.error !== null) {
    assert.equal(typeof record.error, "string");
  }
  __resetUsageRefreshStateForTests();
});
