test("startUsageRefresh installs a timer with the requested interval", () => {
  const original = globalThis.setInterval;
  const captured: { interval: number | null } = { interval: null };
  try {
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      captured.interval = ms ?? 0;
      return { unref: () => {}, ref: () => {}, hasRef: () => false, refresh: () => {}, [Symbol.toPrimitive]: () => 0 } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    startUsageRefresh({ intervalMs: 90_000, log: () => {} });
  } finally {
    globalThis.setInterval = original;
    stopUsageRefresh();
    __resetUsageRefreshStateForTests();
  }
  assert.equal(captured.interval, 90_000);
});
