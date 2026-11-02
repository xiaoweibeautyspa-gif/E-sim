test("startUsageRefresh is idempotent — a second call does not install a new timer", () => {
  const original = globalThis.setInterval;
  let callCount = 0;
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      callCount += 1;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    const logs: string[] = [];
    startUsageRefresh({ intervalMs: 90_000, log: (m) => logs.push(m) });
    startUsageRefresh({ intervalMs: 90_000, log: (m) => logs.push(m) });
    assert.equal(callCount, 1, "setInterval must be called exactly once");
    assert.ok(logs.some((l) => /already started/.test(l)));
  } finally {
    globalThis.setInterval = original;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
});
