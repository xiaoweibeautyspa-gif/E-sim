test("intervalMs below 60s is clamped to 60s", () => {
  const original = globalThis.setInterval;
  let capturedInterval = -1;
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) => { capturedInterval = ms ?? -1; return { unref: () => {} } as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval;
    startUsageRefresh({ intervalMs: 1, log: () => {} });
  } finally {
    globalThis.setInterval = original;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
  assert.equal(capturedInterval, 60_000);
});
