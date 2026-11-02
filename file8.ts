test("stopUsageRefresh clears the installed timer", () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let cleared = 0;
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) =>
      ({ unref: () => {} }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval;
    globalThis.clearInterval = ((t: NodeJS.Timeout) => { cleared += 1; }) as unknown as typeof clearInterval;
    startUsageRefresh({ intervalMs: 90_000, log: () => {} });
    stopUsageRefresh();
    assert.equal(cleared, 1);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
});
